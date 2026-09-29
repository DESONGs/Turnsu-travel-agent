import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AppleLogo, ArrowCounterClockwise, ArrowsClockwise, Baby, BatteryCharging, CalendarBlank, CaretDown, CheckCircle, ChatsCircle, CircleNotch,
  Clock, CloudSun, Compass, CurrencyCircleDollar, Elevator, ForkKnife, Globe, GoogleLogo, Heart, House, List, MapPin,
  ImageSquare, Info, LinkSimple, MapTrifold, Microphone, NavigationArrow, PaperPlaneRight, PersonSimpleWalk, Plus, QrCode, SignOut, Sparkle, User,
  Stairs, StopCircle, Toilet, Train, Trash, WarningCircle, WechatLogo, Wheelchair, X,
} from "@phosphor-icons/react";
import { Tabs } from "@base-ui/react/tabs";
import { api, clearDesktopAccessToken, setDesktopAccessToken } from "./api-client.js";
import { LoginScreen, AccountCenter } from "./account-experience.jsx";
import { shouldHideMobileNavigation } from "./mobile-keyboard-state.js";
import { shouldSendComposerKey, nextTrialNodeId, runJourneyAction, hasRouteMeasurements, hasTripMapPoints } from "./journey-interaction.js";
import { OverlaySurface } from "./ui/overlay.jsx";
import { MessageScroller } from "./ui/message-scroller.jsx";
import { ExecutionProgress, isRunActive } from "./execution-progress.jsx";

import { AuthenticatedMapImage } from "./authenticated-map-image.jsx";
import "./travel-photo-journal.css";
import "./trip-atlas.css";
const LazyTravelPhotoJournal = lazy(() => import("./travel-photo-journal.jsx").then((module) => ({ default: module.TravelPhotoJournal })));
const LazyTripDecisionMap = lazy(() => import("./trip-map-explorer.jsx").then((module) => ({ default: module.TripDecisionMap })));
const LazyDestinationExperiencePreview = lazy(() => import("./destination-experience-preview.jsx").then((module) => ({ default: module.DestinationExperiencePreview })));

const DOMAIN_ITEMS = [
  { key: "play", label: "玩", icon: Compass },
  { key: "food", label: "吃", icon: ForkKnife },
  { key: "stay", label: "住", icon: House },
  { key: "transport", label: "行", icon: Train },
];
const STARTER_PROMPTS_ZH = [
  { title: "带家人轻松旅行", detail: "分别考虑体力、步行和住宿位置", text: "国庆和父母去大理 5 天，轻松一点，住得方便，想吃本地菜。", icon: PersonSimpleWalk },
  { title: "第一次探索一座城", detail: "把兴趣、路线和落脚点放在一起", text: "第一次来上海 3 天，想兼顾建筑、咖啡和适合步行的路线。", icon: Compass },
  { title: "先控制整趟预算", detail: "比较住宿、交通和体验的取舍", text: "两个人去北京看秋色，预算 8000，交通尽量少换乘。", icon: CurrencyCircleDollar },
];
const STARTER_PROMPTS_EN = [
  { title: "Take an easy family trip", detail: "Plan energy, walking and where to stay", text: "My parents and I have 5 relaxed days in Dali. We want an easy hotel location and local food.", icon: PersonSimpleWalk },
  { title: "Explore a city for the first time", detail: "Connect interests, routes and a stay anchor", text: "First time in Shanghai for 3 days. We like architecture, coffee and walkable routes.", icon: Compass },
  { title: "Set the whole-trip budget", detail: "Compare stays, transport and experiences", text: "Two people visiting Beijing in autumn, CNY 8,000 total, with as few transfers as possible.", icon: CurrencyCircleDollar },
];
const UiLocaleContext = createContext({ locale: "zh-CN", setLocale: () => {}, pick: (zh) => zh });

function initialUiLocale() {
  if (typeof window === "undefined") return "zh-CN";
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested === "en" || requested === "en-US") return "en";
  if (requested === "zh" || requested === "zh-CN") return "zh-CN";
  const stored = window.localStorage.getItem("travel-agent-ui-locale");
  if (stored === "en" || stored === "zh-CN") return stored;
  return String(window.navigator.language || "zh-CN").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function useUiLocale() {
  return useContext(UiLocaleContext);
}

function TripDecisionMap(props) {
  const { pick } = useUiLocale();
  return <Suspense fallback={<div className="trip-map-loading" role="status"><MapTrifold weight="duotone" /><span><strong>{pick("正在载入地图", "Loading map")}</strong><small>{pick("地点与行程会保持同步", "Places and the trip stay in sync")}</small></span></div>}><LazyTripDecisionMap {...props} /></Suspense>;
}

function domainLabel(domain, locale = "zh-CN") {
  const labels = { play: ["玩", "Explore"], food: ["吃", "Eat"], stay: ["住", "Stay"], transport: ["行", "Move"] };
  return labels[domain]?.[locale === "en" ? 1 : 0] ?? domain;
}
const SESSION_PROVIDER_LABELS = { google: "Google", wechat: "微信", alipay: "支付宝", apple: "Apple", email_otp: "本地体验", guest: "临时旅行" };
const VISIT_TAG_LABELS = Object.freeze({
  local_character: "很有当地特色",
  worth_detour: "值得专程去",
  easy_to_reach: "位置好找",
  low_queue: "等待可接受",
  helpful_service: "沟通顺利",
  family_friendly: "适合同行家人",
  quiet_rest: "休息体验好",
  accurate_listing: "现场与资料相符",
  useful_facilities: "设施有帮助",
  foreigner_friendly: "入境游客较易使用",
  good_value: "花费合理",
  comfortable_pace: "节奏舒服",
});
const VISIT_TAGS_BY_DOMAIN = Object.freeze({
  food: ["local_character", "worth_detour", "low_queue", "helpful_service", "good_value", "foreigner_friendly"],
  play: ["local_character", "worth_detour", "easy_to_reach", "comfortable_pace", "family_friendly", "useful_facilities"],
  stay: ["easy_to_reach", "quiet_rest", "accurate_listing", "helpful_service", "useful_facilities", "foreigner_friendly"],
});

function formatTime(value, locale = "zh-CN") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (locale === "en" ? "Just now" : "刚刚") : new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatConversationRecency(value, locale = "zh-CN") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return locale === "en" ? "Updated just now" : "刚刚更新";
  const now = new Date();
  const sameDay = now.toDateString() === date.toDateString();
  return sameDay
    ? `${locale === "en" ? "Today" : "今天"} ${new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}`
    : new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}


function formatCheckedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "核验时间未知";
  return `${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)} 核验`;
}

function normalizedUiPrice(candidate) {
  const source = candidate?.price && typeof candidate.price === "object" ? candidate.price : null;
  const legacyAmount = Number(candidate?.cost);
  const amount = source
    ? source.amount == null ? null : Number(source.amount)
    : Number.isFinite(legacyAmount) && legacyAmount > 0 ? legacyAmount : null;
  return {
    amount: Number.isFinite(amount) && amount >= 0 ? amount : null,
    currency: source?.currency || "CNY",
    quality: ["firm", "reference", "estimate", "unknown"].includes(source?.quality) ? source.quality : amount == null ? "unknown" : "reference",
    basis: source?.basis || null,
    checkedAt: source?.checkedAt || candidate?.operability?.checkedAt || null,
  };
}

function localizedPriceBasis(value, locale = "zh-CN") {
  const english = locale === "en";
  const labels = {
    per_night_room: english ? "per room / night" : "每间每晚",
    per_night_room_reference: english ? "room-night reference" : "单晚参考",
    per_person_one_way: english ? "per person / one way" : "每人单程",
    per_person: english ? "per person" : "每人",
    per_person_reference: english ? "per-person reference" : "人均参考",
  };
  return labels[value] || value;
}

function PriceSlot({ candidate, compact = false }) {
  const { locale, pick } = useUiLocale();
  const price = normalizedUiPrice(candidate);
  if (price.amount == null || price.quality === "unknown") return <span className={`price-slot unknown ${compact ? "compact" : ""}`}><strong>{pick("待核验", "Price pending")}</strong><small>{pick("未取得可靠价格", "No reliable price yet")}</small></span>;
  const prefix = price.quality === "reference" ? "≈" : price.quality === "estimate" ? "~" : "";
  const qualityLabel = price.quality === "firm" ? (price.checkedAt ? formatCheckedAt(price.checkedAt) : pick("本次实价", "Current quote")) : price.quality === "reference" ? pick("参考", "Reference") : pick("确定性估算", "Estimated");
  return <span className={`price-slot ${price.quality} ${compact ? "compact" : ""}`}><strong>{prefix}¥{new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 0 }).format(price.amount)}</strong><small>{[qualityLabel, localizedPriceBasis(price.basis, locale)].filter(Boolean).join(" · ")}</small></span>;
}

function consumerProviderLabel(value) {
  const raw = String(value ?? "").trim();
  const known = {
    amap_web_service: "Amap 高德地图",
    amap_routes_v5: "Amap 高德路线",
    fliggy_flyai: "Fliggy 飞猪",
    flyai: "Fliggy 飞猪",
    tuniu: "Tuniu 途牛",
    tuniu_official_mcp: "Tuniu 途牛",
    traveler_visit_feedback: "到访者反馈",
    xiaohongshu: "小红书",
    douyin: "抖音",
    wechat: "微信文章",
  }[raw.toLowerCase()];
  if (known) return known;
  const cleaned = raw
    .replace(/\s*AI\s*开放平台/gi, "")
    .replace(/\s*官方\s*MCP/gi, "")
    .replace(/\s*MCP/gi, "")
    .replace(/\s*\+\s*/g, "、")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "旅行资料来源";
}

function tripBriefChips(trip, locale = "zh-CN") {
  if (!trip) return [];
  const en = locale === "en";
  return [
    { key: "destination", label: trip.destination || (en ? "Destination needed" : "目的地待补"), missing: !trip.destination, prompt: en ? "I want to add or change the destination: " : "我想补充目的地：" },
    { key: "dates", label: trip.dates || (trip.durationDays ? `${trip.durationDays} ${en ? "days" : "天"}` : (en ? "Dates needed" : "时间待补")), missing: !trip.dates && !trip.durationDays, prompt: en ? "My travel dates are: " : "我想补充旅行时间：" },
    { key: "travelers", label: trip.travelerCount ? (en ? `${trip.travelerCount} travelers` : `${trip.travelerCount} 人同行`) : (en ? "Add travelers" : "人数待补"), missing: !trip.travelerCount, prompt: en ? "I want to update the travelers: " : "我想调整同行人：" },
    { key: "pace", label: trip.pace || (en ? "Pace needed" : "节奏待补"), missing: !trip.pace, prompt: en ? "The pace we want is: " : "我希望旅行节奏是：" },
    { key: "origin", label: trip.origin ? (en ? `From ${trip.origin}` : `${trip.origin}出发`) : (en ? "Origin needed" : "出发地待补"), missing: !trip.origin, prompt: en ? "We are departing from: " : "我从这里出发：" },
    { key: "budget", label: trip.totalBudget != null ? `${en ? "Budget" : "预算"} ¥${new Intl.NumberFormat(en ? "en-US" : "zh-CN").format(trip.totalBudget)}` : (en ? "Budget needed" : "预算待补"), missing: trip.totalBudget == null, prompt: en ? "Our total trip budget is: " : "这趟旅行的总预算是：" },
  ];
}

function quickRepliesForTrip(trip, locale = "zh-CN") {
  if (!trip) return [];
  const en = locale === "en";
  if (trip.totalBudget == null) return [
    { label: en ? "Location first" : "位置优先", text: en ? "Prioritize a convenient stay location; adjust the budget based on the time it saves." : "住宿位置优先，预算可以根据方便程度再权衡。" },
    { label: en ? "Stay under ¥500/night" : "住宿每晚 ¥500 内", text: en ? "Keep the stay budget under CNY 500 per night." : "住宿预算希望控制在每晚 500 元以内。" },
    { label: en ? "Stay ¥500-900/night" : "住宿每晚 ¥500-900", text: en ? "A stay budget of CNY 500 to 900 per night works for us." : "住宿预算可以接受每晚 500 到 900 元。" },
  ];
  if (!trip.origin) return [
    { label: en ? "Add departure city" : "补充出发地", prefill: en ? "We are departing from: " : "我从这里出发：" },
    { label: en ? "Plan destination first" : "暂不安排城际", text: en ? "Plan the stay, experiences, food and local transport first. Add intercity transport later." : "先规划目的地内的住宿、游玩、美食和当地交通，城际交通之后再补。" },
    { label: en ? "Fewer transfers" : "优先少换乘", text: en ? "Prioritize fewer transfers for intercity and local transport." : "城际和当地交通都优先少换乘。" },
  ];
  return [
    { label: en ? "Less walking" : "少走路", text: en ? "Reduce daily walking without changing unaffected confirmed plans." : "请在不改变已确认安排的前提下，让每天少走一点。" },
    { label: en ? "Location first" : "位置优先", text: en ? "Prefer stay and food locations that keep the route direct." : "住宿和餐饮优先选择更顺路的位置。" },
    { label: en ? "Lower the cost" : "控制预算", text: en ? "Compare a lower-cost version that does not clearly increase physical effort." : "请比较一版更节省预算、但不明显增加体力负担的方案。" },
  ];
}

function messageError(error) {
  const messages = {
    authentication_required: "登录会话已失效，请重新登录。",
    guest_trip_expired: "这次临时旅行已经过期。登录后可以长期保存新的旅行。",
    conversation_access_denied: "你没有访问这段旅行对话的权限。",
    execution_queue_full: "当前请求较多，请稍后再提交。已保存的旅行仍可查看。",
    execution_connection_lost: "连接暂时中断，请求已保存。点击重新连接查看结果，无需重复发送。",
    execution_request_id_conflict: "这条请求的内容发生了变化，请刷新查看已保存的请求。",
    question_stale: "旅行条件已经更新，这个问题已失效。已保留你的文字，请根据当前方案继续。",
    question_already_answered: "这个问题已在另一端回答，正在同步最新方案。",
    sensitive_conversation_input_blocked: "为保护隐私，请不要发送证件号、支付卡号、Cookie、Token 或密码。只需描述相关的可操作性要求即可。",
    empty_conversation_message: "先写下这趟旅行的想法。",
    itinerary_not_executable: "这份试排仍有未满足的旅行约束，请查看核验提示，处理后再采用。",
    trip_constraints_unmet: "当前预算或必需条件尚未满足，安排没有采用。请按核验提示调整。",
    itinerary_preview_stale: "旅行条件刚刚变化，请重新核验这份试排后再采用。",
  };
  return messages[error.code] ?? "这次没有处理完成，请稍后重试。你的旅行内容不会丢失。";
}

function MessageBody({ text }) {
  const { pick } = useUiLocale();
  const [expanded, setExpanded] = useState(false);
  const lines = String(text ?? "").split(/\n+/).filter((line, index, values) => line.trim() || (index > 0 && index < values.length - 1));
  const isLong = String(text ?? "").length > 560 || lines.length > 4;
  const visibleLines = !expanded && isLong
    ? (lines.length > 3 ? [lines[0], lines[1], lines.at(-1)] : lines)
    : lines;
  return <div className={`message-body ${isLong && !expanded ? "collapsed" : ""}`}>{visibleLines.map((line, index) => {
    const pieces = line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return <span key={`${line}-${index}`} className="message-line">{pieces.map((piece, pieceIndex) => piece.startsWith("**") && piece.endsWith("**") ? <strong key={pieceIndex}>{piece.slice(2, -2)}</strong> : piece)}</span>;
  })}{isLong ? <button type="button" className="message-expand" onClick={() => setExpanded((current) => !current)}>{expanded ? pick("收起说明", "Show less") : pick("展开完整说明", "Show full explanation")}<CaretDown className={expanded ? "expanded" : ""} /></button> : null}</div>;
}

function MessageBubble({ message }) {
  const { locale, pick } = useUiLocale();
  if (message.role === "status") return <div className="conversation-status"><WarningCircle weight="fill" /><span>{message.text}</span></div>;
  return <article className={`chat-message ${message.role}`}>
    <div className="message-avatar" aria-hidden="true">{message.role === "user" ? pick("你", "You") : <Sparkle weight="fill" />}</div>
    <div className="message-copy">{message.kind === "multimodal_input" ? <span className="message-media-badge"><ImageSquare weight="fill" />{pick("包含一张临时旅行图片 · 原图未保存", "Included a temporary travel image · original not saved")}</span> : null}<MessageBody text={message.text} /><time>{message.role === "user" ? pick("你的需求", "Your request") : "Travel Agent"} · {formatTime(message.createdAt, locale)}</time></div>
  </article>;
}

function ThinkingMessage({ hasPlan = false, onBackground = null }) {
  const { pick } = useUiLocale();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const waitingLonger = elapsedSeconds >= 20;
  return <article className="chat-message assistant typing" aria-live="polite" aria-label={pick("旅行助手正在处理这次请求", "Travel Agent is working on this request")}><div className="message-avatar"><Sparkle weight="fill" /></div><div className="thinking-state"><div className="typing-dots"><i /><i /><i /></div><small><strong>{waitingLonger ? pick("仍在处理这次旅行请求", "Still working on this travel request") : pick("正在处理这次旅行请求", "Working on this travel request")}</strong><span>{waitingLonger ? pick("当前还没有新的可确认结果；旧方案会保留，你可以先回去继续查看。", "There is no new confirmable result yet. Your existing plan stays available while this continues.") : pick("完成后会显示实际执行的核验步骤，不预演尚未发生的进度。", "The actual verification steps will appear when complete; unfinished work is not presented as progress.")}</span><time>{elapsedSeconds}s</time>{waitingLonger && hasPlan ? <button type="button" onClick={onBackground}>{pick("回到旧方案，后台继续", "View the existing plan while this continues")}</button> : null}</small></div></article>;
}

function StarterSuggestions({ onPrompt }) {
  const { locale, pick } = useUiLocale();
  const prompts = locale === "en" ? STARTER_PROMPTS_EN : STARTER_PROMPTS_ZH;
  return <section className="journey-starters" aria-label={pick("选择一个想法，修改后再发送", "Choose an idea and edit it before sending")}>
    <p>{pick("还没想好？从一个想法开始", "Need a starting point?")}</p>
    <div className="prompt-suggestions">{prompts.map(({ title, detail, text, icon: Icon }) => <button key={title} type="button" onClick={() => onPrompt(text)}><Icon weight="duotone" /><span><strong>{title}</strong><small>{detail}</small></span><NavigationArrow /></button>)}</div>
  </section>;
}

function ConversationIntro() {
  const { pick } = useUiLocale();
  return <section className="journey-welcome">
    <span className="journey-eyebrow"><Compass weight="duotone" />{pick("旅行，从你的想法开始", "A journey shaped around you")}</span>
    <h1>{pick("下一趟，想去哪里？", "Where would you like to go?")}</h1>
    <p>{pick("说说目的地、同行人，或你最在意的事。", "Share a destination, who’s coming, or what matters most.")}<br />{pick("一起把吃、住、行、玩安排得从容。", "We’ll connect the places, stays, food and the way between.")}</p>
  </section>;
}

function imagePayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Object.assign(new Error("image_read_failed"), { code: "image_read_failed" }));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function Composer({ value, onChange, onSubmit, loading, blocked = false, inputRef, contextLabel, onClearContext, onInspectImage, onLinkPrompt, imageAttachment, onRemoveImage, imageLoading = false }) {
  const { locale, pick } = useUiLocale();
  const fallbackInputRef = useRef(null);
  const resolvedInputRef = inputRef ?? fallbackInputRef;
  const recognitionRef = useRef(null);
  const imageInputRef = useRef(null);
  const [voiceState, setVoiceState] = useState("idle");
  const [voiceNotice, setVoiceNotice] = useState("");
  useEffect(() => () => {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition.abort();
    }
  }, []);
  const speechRecognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  const toggleVoice = () => {
    if (voiceState === "listening") {
      recognitionRef.current?.stop();
      return;
    }
    if (!speechRecognition) {
      setVoiceNotice(pick("当前设备暂不支持语音转写，请使用键盘输入。", "Voice transcription is not available on this device. Please type instead."));
      return;
    }
    const recognition = new speechRecognition();
    recognition.lang = locale === "en" ? "en-US" : "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    const base = value.trim();
    recognition.onstart = () => { setVoiceState("listening"); setVoiceNotice(pick("正在听，转写后可以修改再发送。", "Listening. You can edit the transcript before sending.")); };
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join("");
      onChange([base, transcript].filter(Boolean).join(base && transcript ? " " : ""));
    };
    recognition.onerror = (event) => {
      setVoiceState("idle");
      setVoiceNotice(event.error === "not-allowed" ? pick("没有取得麦克风权限，请在系统设置中允许后重试。", "Microphone access was not granted. Allow it in system settings and try again.") : pick("这次没有听清，可以重试或继续打字。", "I could not hear that clearly. Try again or continue typing."));
    };
    recognition.onend = () => { setVoiceState("idle"); setVoiceNotice((current) => current || pick("转写完成，可以修改后发送。", "Transcription complete. Edit it before sending if needed.")); };
    recognitionRef.current = recognition;
    recognition.start();
  };
  return <form className={`chat-composer ${contextLabel ? "has-context" : ""} ${imageAttachment ? "has-image" : ""}`} onSubmit={(event) => { event.preventDefault(); if (!loading && !blocked && (value.trim() || imageAttachment)) onSubmit(value); }}>
    {contextLabel ? <div className="composer-context" role="status"><span>{pick("正在补充", "Adding")} <strong>{contextLabel}</strong></span><button type="button" onClick={onClearContext}>{pick("取消", "Cancel")}</button></div> : null}
    {imageAttachment ? <div className="composer-image-preview"><img src={imageAttachment.previewUrl} alt={pick("待发送的旅行图片预览", "Travel image ready to send")} /><span><strong>{imageAttachment.name}</strong><small>{imageAttachment.savedInJournal ? pick("照片已在旅行手账中保存；确认发送后用于本次规划", "Saved in your journal; send to use it in this plan") : pick("会与这条消息一起交给旅行助手；原图不会保存", "Sent with this message; the original is not saved")}</small></span><button type="button" onClick={onRemoveImage} aria-label={pick("移除图片", "Remove image")}><X /></button></div> : null}
    <div className="composer-writing-head"><label htmlFor="travel-message">{pick("说说这趟旅行", "Describe this trip")}</label><small>{pick("Enter 发送，Shift + Enter 换行", "Enter to send, Shift + Enter for a new line")}</small></div>
    <textarea id="travel-message" ref={resolvedInputRef} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (shouldSendComposerKey(event.nativeEvent) && !loading && !blocked && (value.trim() || imageAttachment)) { event.preventDefault(); onSubmit(value); } }} rows={3} maxLength={4_000} placeholder={pick("例如：和父母去大理 5 天，轻松一点，住得方便，想吃本地菜。", "For example: First time in Shanghai for 4 days, two travelers, easy pace, CNY 9,000 total.")} />
    <div className="composer-footer">
      <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onInspectImage?.(file); }} />
      <div className="composer-media-actions"><button type="button" className="media-button" onClick={() => imageInputRef.current?.click()} disabled={loading || imageLoading} aria-label={pick("上传旅行截图或图片", "Upload a travel screenshot or image")}>{imageLoading ? <CircleNotch className="spin" /> : <ImageSquare weight="bold" />}<span>{pick("图片", "Image")}</span></button><button type="button" className="media-button" onClick={onLinkPrompt} disabled={loading || imageLoading} aria-label={pick("粘贴旅行分享链接", "Paste a travel share link")}><LinkSimple weight="bold" /><span>{pick("链接", "Link")}</span></button></div>
      <button type="button" className={`voice-button ${voiceState}`} onClick={toggleVoice} aria-label={voiceState === "listening" ? pick("停止语音输入", "Stop voice input") : pick("开始语音输入", "Start voice input")} aria-pressed={voiceState === "listening"}>{voiceState === "listening" ? <StopCircle weight="fill" /> : <Microphone weight="bold" />}</button>
      <span className="composer-privacy" role={voiceNotice ? "status" : undefined}>{voiceNotice || (imageAttachment ? pick("请勿上传证件、支付信息或联系方式", "Do not upload identity, payment or contact information") : pick("由你确认后再发送", "Review before sending"))}</span>
      <button className="send-button" aria-label={pick("发送旅行需求", "Send travel request")} disabled={loading || blocked || (!value.trim() && !imageAttachment)}><span>{loading ? pick("规划中", "Planning") : pick("开始规划", "Plan my trip")}</span>{loading ? <CircleNotch className="spin" /> : <PaperPlaneRight weight="fill" />}</button>
    </div>
  </form>;
}

function ActivityStrip({ activities }) {
  const { locale, pick } = useUiLocale();
  if (!activities?.length) return null;
  const labels = locale === "en"
    ? { interpret_visual_context: "Understanding the image with this trip", save_trip_understanding: "Trip requirements saved", research_trip_options: "Researching the connected trip", get_trip_control_view: "Trip requirements loaded", get_trip_plan_view: "Current plan loaded", estimate_costs: "Trip budget calculated", explain_recommendation: "Recommendation evidence loaded", plan_itinerary_trial: "Itinerary route checked", confirm_user_arrival: "Confirmed arrival saved", confirm_trip_selection: "Selected option confirmed", accept_trip_change: "Plan confirmed", refresh_trip_mobility: "City movement checked", reject_trip_change: "Options dismissed", trip_readiness: "Travel readiness updated" }
    : { interpret_visual_context: "已结合这趟旅行理解图片", save_trip_understanding: "已记住旅行要求", research_trip_options: "已核验吃住行玩候选", get_trip_control_view: "已读取旅行要求", get_trip_plan_view: "已读取当前方案", estimate_costs: "已按真实价格口径计算整趟预算", explain_recommendation: "已读取候选的推荐依据", plan_itinerary_trial: "已核验行程站序与路线", confirm_user_arrival: "已记录确认的抵达事实", confirm_trip_selection: "已确认所选候选", accept_trip_change: "已确认方案", refresh_trip_mobility: "已核验城市内移动", reject_trip_change: "已放弃候选", trip_readiness: "已更新出发准备" };
  const failureStatuses = new Set(["provider_unavailable", "AUTH_REQUIRED", "ACCOUNT_LIMITED", "RATE_LIMITED", "SOURCE_UNAVAILABLE", "EMPTY_VERIFIED", "failed", "error", "blocked", "needs_context", "stale_discarded"]);
  const latest = [...new Map(activities.map((activity) => [`${activity.toolName}:${activity.attempt ?? "single"}`, activity])).values()];
  const repaired = activities.some((activity) => activity.toolName === "plan_itinerary_trial" && activity.status === "trial_ready");
  const activityText = (activity) => activity.toolName === "plan_itinerary_trial" && activity.status === "needs_repair" ? pick("路线核验发现冲突，已进入一次修正", "A route conflict was found and one repair was started") : activity.toolName === "plan_itinerary_trial" && activity.status === "trial_ready" ? pick("路线、时间与同行人限制已核验，可比较优化试排", "Route, timing and traveler constraints checked; the optimized draft is ready") : activity.toolName === "plan_itinerary_trial" && activity.status === "stale_discarded" ? pick("旅行条件已变化，旧试排已丢弃", "Trip conditions changed; the old draft was discarded") : activity.toolName === "plan_itinerary_trial" && ["blocked", "needs_context"].includes(activity.status) ? pick("这次没有形成可执行优化路线", "No executable optimized route was produced") : activity.toolName === "interpret_visual_context" && activity.status === "completed" ? pick("已结合图片理解这次需求", "Image understood in this request") : activity.toolName === "interpret_visual_context" && activity.status === "failed" ? pick("这次没有读完图片", "The image could not be read") : activity.toolName === "confirm_user_arrival" && activity.status !== "committed" ? pick("抵达事实尚未确认", "Arrival is not confirmed yet") : activity.toolName === "confirm_trip_selection" && activity.status !== "committed" ? pick("候选尚未确认", "The option is not confirmed yet") : activity.toolName === "research_trip_options" && activity.status === "error" ? pick("本轮没有重新搜索，原候选保持不变", "No new search was run; existing options were kept") : activity.toolName === "restore_trip_draft" ? activity.status === "recovered" ? pick("已恢复旅行草案", "Trip draft restored") : pick("旅行草案需要恢复", "Trip draft needs recovery") : activity.toolName === "research_trip_options" && ["provider_unavailable", "AUTH_REQUIRED", "SOURCE_UNAVAILABLE"].includes(activity.status) ? pick("没有取得实时地点资料", "Live place data was not available") : activity.toolName === "research_trip_options" && activity.status === "ACCOUNT_LIMITED" ? pick("地图资料暂时无法访问", "Map data is temporarily unavailable") : activity.toolName === "research_trip_options" && activity.status === "RATE_LIMITED" ? pick("实时资料请求较多，请稍后再试", "Live sources are busy. Try again shortly.") : activity.toolName === "research_trip_options" && activity.status === "EMPTY_VERIFIED" ? pick("本次来源未返回可核验结果", "The checked sources returned no verified result") : activity.toolName === "refresh_trip_mobility" && activity.status === "provider_unavailable" ? pick("城市路线资料暂不可用", "City routing is temporarily unavailable") : activity.toolName === "refresh_trip_mobility" && activity.status === "needs_context" ? pick("确认更多地点后再核验路线", "Confirm more places before routing") : `${labels[activity.toolName] ?? pick("已处理旅行要求", "Travel request processed")}${activity.status === "proposed" ? pick("，可以在方案中比较", "; ready to compare") : ""}`;
  return <section className="agent-progress-rail" aria-live="polite" aria-label={pick("本轮处理记录", "Steps for this request")}><header><Sparkle weight="fill" /><span><strong>{pick("本轮处理情况", "What happened this time")}</strong><small>{pick("只显示实际完成或明确失败的步骤", "Only completed or explicitly failed steps are shown")}</small></span></header><ol>{latest.map((activity) => { const repairResolved = activity.status === "needs_repair" && repaired; const warning = failureStatuses.has(activity.status) || (activity.status === "needs_repair" && !repairResolved); const running = activity.status === "running"; const stateLabel = running ? pick("处理中", "In progress") : repairResolved ? pick("已修正", "Repaired") : warning ? pick("需要处理", "Needs attention") : pick("已完成", "Completed"); return <li key={`${activity.toolName}:${activity.attempt ?? "single"}`} className={warning ? "warning" : running ? "running" : "complete"}><i>{running ? <CircleNotch className="spin" /> : warning ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />}</i><span><strong>{activityText(activity)}</strong><small>{stateLabel}</small></span></li>; })}</ol></section>;
}

function CandidatePhoto({ candidate }) {
  const photo = candidate.media?.[0];
  return photo ? <img className="candidate-photo" src={photo.url} alt={photo.title || `${candidate.title}实景图`} loading="lazy" referrerPolicy="no-referrer" /> : null;
}

function mappedFacilityLabels(detail) {
  return (detail?.mappedFacilities ?? []).map((facility) => facility.label).filter(Boolean);
}

function domainMeta(domain) {
  return DOMAIN_ITEMS.find((item) => item.key === domain) ?? DOMAIN_ITEMS[0];
}

function scheduleLabel(item) {
  const planningWindow = item?.operability?.planningWindow;
  if (planningWindow?.label) return planningWindow.basis === "agent_suggested_window" ? `${planningWindow.label}（建议）` : planningWindow.label;
  const value = item?.domain === "transport" && ["intercity_inventory", "user_confirmed_arrival"].includes(item?.operability?.mobilityRole)
    ? item?.operability?.arrivalAt ?? planningWindow?.endAt ?? item?.time
    : item?.time ?? item?.operability?.arrivalAt ?? item?.operability?.departureAt;
  if (!value) return "待排入日程";
  if (/^\d{1,2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function scheduleSortValue(item) {
  const value = item?.domain === "transport" && ["intercity_inventory", "user_confirmed_arrival"].includes(item?.operability?.mobilityRole)
    ? item?.operability?.arrivalAt ?? item?.operability?.planningWindow?.endAt ?? item?.time
    : item?.operability?.planningWindow?.startAt ?? item?.time ?? item?.operability?.arrivalAt ?? item?.operability?.departureAt;
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function compactDateTime(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(?:20\d{2}-)?(\d{1,2})-(\d{1,2})[ T](\d{1,2}:\d{2})/);
  return match ? `${Number(match[1])}月${Number(match[2])}日 ${match[3]}` : raw || "待核验";
}

function compactTripDates(value, durationDays = null, locale = "zh-CN") {
  const dates = [...String(value ?? "").matchAll(/20\d{2}-(\d{2})-(\d{2})/g)].map((match) => `${Number(match[1])}/${Number(match[2])}`);
  if (dates.length >= 2) return `${dates[0]}–${dates[1]}`;
  if (dates.length === 1) return dates[0];
  return durationDays ? `${durationDays} ${locale === "en" ? "days" : "天"}` : (locale === "en" ? "Dates needed" : "时间待补");
}

function TransportSnapshot({ detail, compact = false }) {
  if (!detail || !["FLIGHT", "TRAIN"].includes(detail.transportType)) return null;
  const departure = detail.departurePlace;
  const arrival = detail.arrivalPlace;
  const fareOffers = detail.fareOffers ?? [];
  const fareOptions = detail.fareOptions ?? [];
  const routeReady = departure?.label || arrival?.label;
  return <section className={`transport-snapshot ${compact ? "compact" : "full"}`} aria-label="城际交通班次和票价">
    {routeReady ? <div className="transport-endpoints"><span><small>{compactDateTime(detail.departureAt)}</small><strong>{departure?.label || detail.departureCity || "出发点待核验"}</strong>{departure?.terminal ? <em>{departure.terminal}</em> : null}</span><NavigationArrow /><span><small>{compactDateTime(detail.arrivalAt)}</small><strong>{arrival?.label || detail.arrivalCity || "到达点待核验"}</strong>{arrival?.terminal ? <em>{arrival.terminal}</em> : null}</span></div> : null}
    <div className="transport-service-line"><span>{detail.transportType === "FLIGHT" ? "航班" : "列车"} {detail.serviceNumber || "班次待核验"}</span>{detail.carrier ? <span>{detail.carrier}</span> : null}{detail.durationMinutes ? <span>约 {Math.floor(detail.durationMinutes / 60) ? `${Math.floor(detail.durationMinutes / 60)} 小时 ` : ""}{detail.durationMinutes % 60 ? `${detail.durationMinutes % 60} 分` : ""}</span> : null}{detail.vehicleModel ? <span>{detail.vehicleModel}</span> : null}</div>
    {detail.researchFit?.arrivalTimeFit === "different" ? <p className="transport-arrival-warning"><WarningCircle weight="fill" />你提供的落地时间是 {detail.researchFit.requestedArrivalTime}；当前库存班次的到达时间不同。若这是已购票的固定抵达，请先确认；否则试排会按所选班次的实际到达时间计算。</p> : null}
    {detail.checkedAt ? <p className="inventory-checked-at">班次与价格为{formatCheckedAt(detail.checkedAt)}的查询快照，之后可能变化</p> : null}
    {fareOffers.length ? <div className="transport-fares">{fareOffers.slice(0, compact ? 2 : 4).map((offer) => <span key={`${offer.provider}-${offer.totalFare}`}><small>{consumerProviderLabel(offer.providerLabel)}</small><strong>¥{offer.totalFare}</strong>{!compact && (offer.baseFare || offer.taxes) ? <em>{offer.baseFare ? `票面 ¥${offer.baseFare}` : ""}{offer.taxes ? ` + 税费 ¥${offer.taxes}` : ""}</em> : null}</span>)}</div> : fareOptions.length ? <div className="transport-fares">{fareOptions.slice(0, compact ? 2 : 5).map((offer) => <span key={offer.seatClass}><small>{offer.seatClass}</small><strong>¥{offer.fare}</strong>{offer.availableSeats != null ? <em>{offer.availableSeats > 0 ? `可见 ${offer.availableSeats} 张` : "当前未见余票"}</em> : null}</span>)}</div> : null}
    {!compact ? <p className="transport-freshness">票价、余位、航站楼与站台可能变化；下单前需在对应供应方再次确认。到达后的市内接驳由高德路线另行核验。</p> : null}
  </section>;
}

function facilityIcon(facility) {
  const value = `${facility?.kind ?? ""} ${facility?.label ?? facility ?? ""}`.toLowerCase();
  if (value.includes("toilet") || value.includes("卫生间") || value.includes("洗手间")) return Toilet;
  if (value.includes("elevator") || value.includes("直梯") || value.includes("电梯")) return Elevator;
  if (value.includes("stair") || value.includes("楼梯") || value.includes("阶梯") || value.includes("扶梯")) return Stairs;
  if (value.includes("ramp") || value.includes("坡道") || value.includes("无障碍")) return Wheelchair;
  if (value.includes("charge") || value.includes("充电")) return BatteryCharging;
  if (value.includes("baby") || value.includes("母婴")) return Baby;
  return MapPin;
}

function FacilityReferences({ facilities, emptyText = "该地点没有返回可用设施资料，不代表现场没有。" }) {
  if (!facilities?.length) return <p className="facility-empty">{emptyText}</p>;
  return <div className="facility-reference-grid">{facilities.map((facility, index) => {
    const normalized = typeof facility === "string" ? { label: facility } : facility;
    const Icon = facilityIcon(normalized);
    const barrier = normalized.kind === "stairs" || /楼梯|阶梯/.test(normalized.label ?? "");
    return <span key={`${normalized.kind ?? normalized.label}-${index}`} className={barrier ? "barrier" : "assist"}><Icon weight="duotone" /><b>{normalized.label || "设施参考"}</b><small>非实时</small></span>;
  })}</div>;
}

function acceptedSourceLabel(item) {
  if (item.sourceStatus === "user_input") return "由你提供，仍待核验";
  if (item.operability?.inventoryVerified === false && item.operability?.bookingProviderLabel) {
    if (item.domain === "stay") return "酒店资料已查询；房态、房型和退改待跳转核验";
    if (item.domain === "transport") return "班次与参考价已查询；余位和退改待跳转核验";
    return "体验资料已查询；票价和库存待跳转核验";
  }
  return item.sourceStatus === "verified_provider" ? "来源资料已核验" : "来源待核验";
}

function amapMarkerUrl(node) {
  const coordinates = node?.location?.coordinates;
  if (!Number.isFinite(coordinates?.longitude) || !Number.isFinite(coordinates?.latitude)) return node?.operability?.navigationUrl ?? null;
  const parameters = new URLSearchParams({
    position: `${coordinates.longitude},${coordinates.latitude}`,
    name: node.title,
    src: "zhuanshu-travel-agent",
    coordinate: coordinates.coordinateSystem === "WGS-84" ? "wgs84" : "gaode",
    callnative: "0",
  });
  return `https://uri.amap.com/marker?${parameters}`;
}

function hasSpecificTravelDates(value) {
  return (String(value ?? "").match(/20\d{2}-\d{2}-\d{2}/g) ?? []).length >= 2;
}

const DISCOVERY_PRIORITIES = Object.freeze([
  { key: "local", label: "更在地", domains: ["food", "play"], prompt: "请重新比较当前候选：优先有独立来源或真实到访反馈支持的当地特色，不要只按热度判断；同时说明证据还缺什么。" },
  { key: "route", label: "少绕路", domains: ["food", "play", "stay", "transport"], prompt: "请结合已选住宿、游玩和交通，优先比较更顺路、少折返的候选，并说明预计移动代价。" },
  { key: "queue", label: "少排队", domains: ["food", "play"], prompt: "请优先比较预约或排队负担较低的候选；没有可靠等待资料时请明确标为待核验。" },
  { key: "inbound", label: "入境友好", domains: ["food", "play", "stay", "transport"], prompt: "请从入境游客角度比较当前候选，重点核验语言、支付、实名证件、导航和外宾住宿资格；未知项不要推断。" },
  { key: "food", label: "饮食与过敏", domains: ["food"], prompt: "请结合同行人的口味、过敏与忌口重新比较餐饮候选，并说明点菜、沟通和交叉污染方面仍需确认什么。" },
]);

function nodeDecisionEvidence(node, mobility = null) {
  if (!node) return { cues: [], unknowns: [], route: null };
  const detail = node.operability ?? {};
  const facilities = mappedFacilityLabels(detail);
  const feedback = node.visitFeedback;
  const cues = [];
  const unknowns = [];
  const mobilityPlace = (mobility?.legs ?? []).flatMap((leg) => [leg.origin, leg.destination]).find((place) => place?.nodeId === node.nodeId && place?.coordinates) ?? null;
  if (node.location?.coordinates || mobilityPlace) cues.push("位置已定位");
  else unknowns.push("地图位置待补");
  if (["verified", "verified_provider"].includes(node.sourceStatus)) cues.push("具名来源已核验");
  if (facilities.length) cues.push(`${facilities.length} 项设施地图参考`);
  else unknowns.push("设施资料待补");
  if (feedback?.experienceCount) cues.push(`${feedback.experienceCount} 次匿名到访反馈`);
  if (feedback?.topTags?.some((tag) => tag.key === "local_character")) cues.push("到访反馈提到当地特色");
  else if (["food", "play"].includes(node.domain)) unknowns.push("当地特色证据待补");
  if (Number.isFinite(node.cost) && node.cost > 0) cues.push(`参考价 ¥${new Intl.NumberFormat("zh-CN").format(node.cost)}`);
  if (node.domain === "stay") {
    if (node.foreignGuestEligible === true) cues.push("外宾住宿资格已核验");
    else if (node.foreignGuestEligible == null) unknowns.push("外宾住宿资格待核验");
  }
  if (node.domain === "food" && feedback?.typicalWaitMinutes == null && detail.waitMinutes == null) unknowns.push("排队时间待补");
  const leg = (mobility?.legs ?? []).find((candidate) => candidate.origin?.nodeId === node.nodeId || candidate.destination?.nodeId === node.nodeId) ?? null;
  const alternative = leg?.alternatives?.find((candidate) => candidate.mode === leg.recommendedMode) ?? null;
  const route = leg && alternative ? {
    label: `${leg.origin.label} → ${leg.destination.label}`,
    mode: MOBILITY_MODE_LABELS[leg.recommendedMode] ?? leg.recommendedMode,
    minutes: alternative.totalMinutes,
    walkingMeters: alternative.walkingMeters,
    transfers: alternative.transfers,
    rationale: leg.rationale,
  } : null;
  return { cues: cues.slice(0, 5), unknowns: unknowns.slice(0, 3), route };
}

function MapFocusSummary({ node, mobility, onPreview }) {
  if (!node) return null;
  const evidence = nodeDecisionEvidence(node, mobility);
  const location = node.location?.label || node.location?.district || node.operability?.arrivalRouteAnchor?.label || node.operability?.arrivalPlace?.label || "地点位置待补";
  return <section className="map-focus-card" aria-live="polite">
    <div className="map-focus-heading"><span><MapPin weight="fill" /></span><div><small>{domainMeta(node.domain).label} · 当前查看</small><strong>{node.title}</strong><p>{location}</p></div>{onPreview ? <button type="button" onClick={onPreview}>完整详情<CaretDown /></button> : null}</div>
    {evidence.route ? <div className="map-route-cue"><Train weight="duotone" /><span><strong>{evidence.route.label}</strong><small>{evidence.route.mode}，约 {evidence.route.minutes} 分钟{evidence.route.walkingMeters != null ? `，步行 ${Math.round(evidence.route.walkingMeters)} 米` : ""}{evidence.route.transfers != null ? `，${evidence.route.transfers} 次换乘` : ""}</small></span></div> : null}
    {evidence.cues.length ? <div className="decision-cues" aria-label="已有判断依据">{evidence.cues.map((cue) => <span key={cue}><CheckCircle weight="fill" />{cue}</span>)}</div> : null}
    {evidence.unknowns.length ? <div className="decision-unknowns"><span>待补证据</span>{evidence.unknowns.map((unknown) => <small key={unknown}>{unknown}</small>)}</div> : null}
  </section>;
}

function PlanNextStep({ trip, plan, onPrefill, onMobileViewChange }) {
  const { locale, pick } = useUiLocale();
  const steps = [];
  if (!hasSpecificTravelDates(trip?.dates)) steps.push({ key: "dates", title: pick("补充具体日期", "Add exact dates"), detail: pick("核验天气、房态和每天节奏", "Check weather, inventory and daily pace"), prompt: pick("我想补充具体旅行日期：", "My exact travel dates are: ") });
  if (!trip?.origin) steps.push({ key: "origin", title: pick("补充出发地", "Add departure city"), detail: pick("补齐城际交通和首末日衔接", "Connect intercity travel and the first/last day"), prompt: pick("我的出发地是：", "We are departing from: ") });
  if (!(plan?.byDomain?.food ?? []).some((node) => node.selected)) steps.push({ key: "food", title: pick("继续找本地菜", "Continue local food research"), detail: pick("把餐饮放进住宿和游玩动线", "Put food on the stay and activity route"), prompt: pick("请继续查找适合我们、顺路的本地菜和餐厅。", "Continue researching local food that fits us and stays on route.") });
  if (!steps.length) return null;
  return <section className="next-step-guide" aria-labelledby="next-step-title"><div><span className="eyebrow">{pick("接下来完成", "Next to complete")}</span><h3 id="next-step-title">{pick("先补最影响整趟旅行的信息", "Add the information that changes the trip most")}</h3></div><div className="next-step-actions">{steps.slice(0, 3).map((step, index) => <button key={step.key} type="button" onClick={() => { onPrefill(step.prompt); onMobileViewChange("conversation"); }}><span>{index + 1}</span><strong>{step.title}</strong><small>{step.detail}</small><NavigationArrow /></button>)}</div></section>;
}

function ProposalPanel({ proposal, trip, plan, selections, onSelect, onPreviewCandidate, onAskAgent, onFocusMap, onAccept, onReject, onClose, loading }) {
  const { locale, pick } = useUiLocale();
  const availableDomains = DOMAIN_ITEMS.filter(({ key }) => (proposal.byDomain?.[key]?.length ?? 0) > 0);
  const [activeDomain, setActiveDomain] = useState(availableDomains[0]?.key ?? DOMAIN_ITEMS[0].key);
  useEffect(() => {
    setActiveDomain(availableDomains[0]?.key ?? DOMAIN_ITEMS[0].key);
  }, [proposal.proposalId]);
  const currentDomain = availableDomains.find(({ key }) => key === activeDomain) ?? availableDomains[0] ?? DOMAIN_ITEMS[0];
  const candidates = proposal.byDomain?.[currentDomain.key] ?? [];
  const activeNodeId = selections[currentDomain.key] ?? candidates[0]?.nodeId ?? null;
  const activeNode = candidates.find((candidate) => candidate.nodeId === activeNodeId) ?? candidates[0] ?? null;
  const priorities = DISCOVERY_PRIORITIES.filter((priority) => priority.domains.includes(currentDomain.key));
  const selectedCount = availableDomains.filter(({ key }) => selections[key]).length;
  return <section className="proposal-panel" role="dialog" aria-modal="true" aria-labelledby={`proposal-${proposal.proposalId}`}>
    <header className="proposal-heading"><div><h3 id={`proposal-${proposal.proposalId}`}>{proposal.title}</h3><p>{proposal.summary}</p></div><div className="proposal-heading-actions"><div className="proposal-source"><strong>{consumerProviderLabel(proposal.providerLabel)}</strong><span>{formatCheckedAt(proposal.checkedAt)}</span></div><button type="button" className="icon-button" onClick={onClose} aria-label={pick("关闭候选池", "Close candidate pool")}><X /></button></div></header>
    <div className="decision-tabs" role="tablist" aria-label="切换要决定的旅行内容">{availableDomains.map(({ key, label, icon: Icon }) => <button key={key} type="button" role="tab" aria-selected={currentDomain.key === key} className={currentDomain.key === key ? "active" : ""} onClick={() => setActiveDomain(key)}><Icon weight="duotone" /><span>{label}</span><small>{selections[key] ? "已选" : `${proposal.byDomain[key].length} 个可选`}</small></button>)}</div>
    <div className="discovery-priority-row"><span>优先考虑</span><div>{priorities.map((priority) => <button key={priority.key} type="button" onClick={() => onAskAgent(priority.prompt, priority.label)}>{priority.label}</button>)}</div><button className="agent-compare-button" type="button" onClick={() => onAskAgent(`请按我的旅行要求比较当前${currentDomain.label}候选：分别说明当地特色证据、同行人适配、预算、路线绕行、等待或预约负担、入境可操作性与来源可信度，最后推荐一个；未知项明确标出。`, `比较${currentDomain.label}候选`)}><Sparkle weight="fill" />让 Agent 替我比较</button></div>
    <section className="proposal-domain focused" aria-labelledby={`${proposal.proposalId}-${currentDomain.key}`}>
      <div className="domain-title"><span><currentDomain.icon weight="duotone" /></span><div><h4 id={`${proposal.proposalId}-${currentDomain.key}`}>选择一个{currentDomain.label}候选</h4><small>点击候选或地图标记进行选择；只会写入你这次确认的内容</small></div></div>
      <div className="proposal-explorer-layout"><div className="candidate-list">{candidates.map((candidate) => {
        const detail = candidate.operability ?? {};
        const locationLabel = candidate.location?.district || candidate.location?.label;
        const facilities = mappedFacilityLabels(detail);
        const selected = selections[currentDomain.key] === candidate.nodeId;
        const decision = nodeDecisionEvidence({ ...candidate, domain: currentDomain.key });
        return <article key={candidate.nodeId} className={`candidate-option ${candidate.media?.[0] ? "has-photo" : "no-photo"} ${selected ? "selected" : ""}`}>
          <label><input type="radio" name={`${proposal.proposalId}-${currentDomain.key}`} checked={selected} onChange={() => onSelect(currentDomain.key, candidate.nodeId)} /><CandidatePhoto candidate={candidate} /><span className="radio-mark" aria-hidden="true" /><span className="candidate-copy"><strong>{candidate.title}</strong><span>{candidate.summary || "地点详情仍待补充核验。"}</span><small>{[locationLabel, detail.rating ? `评分 ${detail.rating}` : null, detail.priceHint ? `${currentDomain.key === "transport" ? "参考票价" : "参考消费"} ${detail.priceHint}` : null, detail.weatherFit === "preferred" ? "天气优先" : detail.weatherFit === "caution" ? "天气需备选" : null].filter(Boolean).join("，")}</small><TransportSnapshot detail={detail} compact />{facilities.length ? <em>设施参考：{facilities.join("、")}，非实时，现场确认</em> : null}{currentDomain.key === "stay" && detail.lodgingDataNature === "amap_place_reference" ? <em>高德提供酒店位置与基础资料；指定日期房态、房型和价格仍待 OTA 核验</em> : currentDomain.key === "stay" && detail.inventoryVerified === false ? <em>酒店参考候选；指定日期房态、房型、早餐、退改和外宾资格需在 OTA 跳转页核验</em> : null}</span></label>
          <div className="candidate-evidence-preview">{decision.cues.slice(0, 3).map((cue) => <span key={cue}>{cue}</span>)}{decision.unknowns.slice(0, 1).map((unknown) => <em key={unknown}>{unknown}</em>)}</div>
          <div className="candidate-links">
            <button type="button" onClick={() => onPreviewCandidate(candidate.nodeId)}><MapTrifold />查看照片和详情</button>
            {detail.navigationUrl && <a href={detail.navigationUrl} target="_blank" rel="noreferrer"><NavigationArrow />在高德查看</a>}
            {detail.bookingUrl && <a href={detail.bookingUrl} target="_blank" rel="noreferrer"><NavigationArrow />在{detail.bookingProviderLabel || "供应方"}查看</a>}
          </div>
        </article>;
      })}{!candidates.length && <p className="domain-empty">这一类暂时没有可靠候选，先保持待安排。</p>}</div><aside className="proposal-map-panel"><header><strong>地点分布与路线关系</strong><button type="button" onClick={onFocusMap}><MapTrifold />专注地图</button></header><TripDecisionMap nodes={candidates.map((candidate) => ({ ...candidate, domain: currentDomain.key }))} activeNodeId={activeNodeId} onFocusNode={(nodeId) => onSelect(currentDomain.key, nodeId)} tripId={trip?.tripId} staticMapAvailable={plan?.mapPreviewAvailable === true} label={`${currentDomain.label}候选地图`} locale={locale} /><MapFocusSummary node={activeNode ? { ...activeNode, domain: currentDomain.key } : null} onPreview={() => activeNode && onPreviewCandidate(activeNode.nodeId)} /></aside></div>
    </section>
    <div className="proposal-notes">{proposal.caveats?.map((note) => <span key={note}><WarningCircle />{note}</span>)}</div>
    <footer className="proposal-actions"><span className="selection-progress">已选择 {selectedCount}/{availableDomains.length || 0} 项，可分批确认</span><button className="quiet-action" onClick={() => onReject(proposal.proposalId)} disabled={loading}>暂不采用</button><button className="button primary" onClick={() => onAccept(proposal.proposalId, selections, { partial: selectedCount < availableDomains.length })} disabled={loading || selectedCount === 0}>{loading ? <CircleNotch className="spin" /> : <CheckCircle weight="fill" />}{selectedCount < availableDomains.length ? `确认已选 ${selectedCount} 项` : "确认整份方案"}</button></footer>
  </section>;
}

function TripMapPreview({ tripId, plan }) {
  const [hidden, setHidden] = useState(false);
  if (!tripId || !plan?.mapPreviewAvailable || hidden) return null;
  const hasRoutes = (plan?.mobility?.legs?.length ?? 0) > 0;
  return <figure className="trip-map-preview"><AuthenticatedMapImage tripId={tripId} alt={hasRoutes ? "这趟旅行已核验移动路线的地图" : "这趟旅行候选地点的地图分布"} onError={() => setHidden(true)} /><figcaption><MapTrifold weight="duotone" /><span><strong>{hasRoutes ? "地点与移动路线" : "地点分布"}</strong>{hasRoutes ? "蓝色折线是当前推荐移动方式的路线估算。" : "地图只显示当前候选，确认前可继续比较。"}</span></figcaption></figure>;
}

function VisitFeedbackSection({ node, onSubmit }) {
  const feedback = node.visitFeedback;
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState("experience");
  const [verdict, setVerdict] = useState("recommend");
  const [tags, setTags] = useState([]);
  const [text, setText] = useState("");
  const [spendCny, setSpendCny] = useState("");
  const [waitMinutes, setWaitMinutes] = useState("");
  const [share, setShare] = useState(true);
  const [status, setStatus] = useState({});
  useEffect(() => {
    setFormOpen(false); setKind("experience"); setVerdict("recommend"); setTags([]); setText(""); setSpendCny(""); setWaitMinutes(""); setShare(true); setStatus({});
  }, [node.nodeId]);
  if (!VISIT_TAGS_BY_DOMAIN[node.domain]) return null;
  const total = feedback?.experienceCount ?? 0;
  const recommendCount = feedback?.recommendation?.recommend ?? 0;
  const toggleTag = (tag) => setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  const submit = async (event) => {
    event.preventDefault();
    const clean = text.trim();
    if (clean.length < 4) return setStatus({ error: "请写一句能帮助下一位旅行者判断的真实情况。" });
    setStatus({ loading: true });
    try {
      await onSubmit({
        category: kind === "fact" ? "fact_correction" : "personal_experience",
        nodeId: node.nodeId,
        text: clean,
        visibility: share ? "anonymous_travelers" : "trip_only",
        ...(kind === "experience" ? {
          verdict,
          tags,
          ...(spendCny !== "" ? { spendCny: Number(spendCny) } : {}),
          ...(waitMinutes !== "" ? { waitMinutes: Number(waitMinutes) } : {}),
        } : {}),
      });
      setFormOpen(false); setText(""); setTags([]); setSpendCny(""); setWaitMinutes("");
      setStatus({ success: kind === "fact" ? "已记录为待核验信息，不会直接改写地点事实。" : share ? "已匿名加入到访参考，下一位旅行者会看到汇总。" : "已保存在这趟旅行中。" });
    } catch (error) {
      setStatus({ error: error?.code === "needs_rebase" ? "旅行方案刚刚更新，请关闭详情后重新打开再提交。" : "暂时没有保存成功，请稍后再试。" });
    }
  };
  return <section className="detail-section visit-feedback-section">
    <header><div><Heart weight="duotone" /></div><span><strong>到访者怎么说</strong><small>{total ? `${total} 次匿名到访反馈 · 只汇总结构化体验` : "还没有到访记录，你可以帮助下一位旅行者"}</small></span></header>
    {total ? <div className="visit-feedback-summary"><div className="visit-recommendation"><strong>{Math.round((recommendCount / total) * 100)}%</strong><span>愿意推荐<small>{recommendCount}/{total} 次到访</small></span></div><div className="visit-summary-facts">{feedback.typicalSpendCny != null ? <span><CurrencyCircleDollar />典型花费约 ¥{feedback.typicalSpendCny}</span> : null}{feedback.typicalWaitMinutes != null ? <span><Clock />典型等待约 {feedback.typicalWaitMinutes} 分钟</span> : null}</div>{feedback.topTags?.length ? <div className="visit-feedback-tags">{feedback.topTags.map((tag) => <span key={tag.key}>{VISIT_TAG_LABELS[tag.key] || tag.key}<small>{tag.count}</small></span>)}</div> : null}</div> : <p className="visit-feedback-empty">到访记录会回答“值不值得去、现场花费与等待怎样”，不会把个人感受冒充地点事实。</p>}
    {feedback?.pendingFactCheckCount ? <div className="visit-fact-warning"><WarningCircle weight="fill" /><span>近期有 {feedback.pendingFactCheckCount} 条现场变化报告正在核验，营业、价格或设施信息建议出发前再确认。</span></div> : null}
    {status.success ? <div className="visit-feedback-success"><CheckCircle weight="fill" />{status.success}</div> : null}
    {node.selected && !formOpen ? <button className="visit-feedback-open" type="button" onClick={() => { setStatus({}); setFormOpen(true); }}><Heart weight="fill" /><span><strong>我去过，留一条到访记录</strong><small>帮助下一位旅行者少做一点攻略</small></span><CaretDown /></button> : null}
    {node.selected && formOpen ? <form className="visit-feedback-form" onSubmit={submit}>
      <div className="visit-feedback-kind" role="group" aria-label="选择反馈类型"><button type="button" aria-pressed={kind === "experience"} className={kind === "experience" ? "active" : ""} onClick={() => setKind("experience")}>体验感受</button><button type="button" aria-pressed={kind === "fact"} className={kind === "fact" ? "active" : ""} onClick={() => setKind("fact")}>现场信息有变化</button></div>
      {kind === "experience" ? <><fieldset><legend>这次体验值得推荐吗？</legend><div className="visit-verdicts">{[["recommend", "值得推荐"], ["mixed", "看情况"], ["not_recommend", "不太推荐"]].map(([value, label]) => <label key={value} className={verdict === value ? "selected" : ""}><input type="radio" name={`verdict-${node.nodeId}`} value={value} checked={verdict === value} onChange={() => setVerdict(value)} />{label}</label>)}</div></fieldset><fieldset><legend>哪些感受最有帮助？</legend><div className="visit-tag-picker">{VISIT_TAGS_BY_DOMAIN[node.domain].map((tag) => <button type="button" key={tag} className={tags.includes(tag) ? "selected" : ""} aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)}>{VISIT_TAG_LABELS[tag]}</button>)}</div></fieldset><div className="visit-number-fields"><label><span>{node.domain === "stay" ? "本次每晚花费" : "本次人均花费"}<small>可不填</small></span><input type="number" min="0" max="1000000" inputMode="decimal" value={spendCny} onChange={(event) => setSpendCny(event.target.value)} placeholder="¥" /></label>{node.domain !== "stay" ? <label><span>现场等待时间<small>可不填</small></span><input type="number" min="0" max="1440" inputMode="numeric" value={waitMinutes} onChange={(event) => setWaitMinutes(event.target.value)} placeholder="分钟" /></label> : null}</div></> : <p className="visit-fact-help">告诉我们搬迁、闭店、价格、支付、设施或营业时间等变化。系统只会标记“待核验”，不会直接改写地点资料。</p>}
      <label className="visit-note"><span>{kind === "fact" ? "现场发生了什么变化？" : "给下一位旅行者的一句话"}</span><textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={600} placeholder={kind === "fact" ? "例如：入口已经搬到街道另一侧，原来的电梯口暂时关闭。" : "例如：本地菜很有特色，周末午餐等了约 25 分钟，带长辈建议提前到。"} /></label>
      <label className="visit-share"><input type="checkbox" checked={share} onChange={(event) => setShare(event.target.checked)} /><span><strong>匿名帮助下一位旅行者</strong><small>不会公开你的账号、同行人或完整行程；自由文字不会直接展示为公共事实。</small></span></label>
      {status.error ? <p className="visit-feedback-error" role="alert">{status.error}</p> : null}
      <footer><button type="button" className="quiet-action" onClick={() => { setFormOpen(false); setStatus({}); }}>取消</button><button type="submit" className="button primary" disabled={status.loading}>{status.loading ? <CircleNotch className="spin" /> : <PaperPlaneRight />}提交到访记录</button></footer>
    </form> : null}
  </section>;
}

function EvidenceCompanionPanel({ bundle, loading, error, node, shareUrl, onShareUrlChange, onResolveShare, onReloadNodeEvidence, onTranslate, translating, resolvingShare, onTrialCandidate }) {
  const { locale, pick } = useUiLocale();
  if (loading) return <section className="evidence-companion-state" role="status"><CircleNotch className="spin" /><div><strong>{pick("正在整理可追溯证据", "Preparing traceable evidence")}</strong><p>{pick("只读取当前候选已有资料，不会把来源内容当作 Agent 指令。", "Only existing candidate evidence is read; source content is never treated as Agent instructions.")}</p></div></section>;
  if (!bundle) return <section className="evidence-companion-state error" role="alert"><WarningCircle weight="fill" /><div><strong>{pick("暂时无法打开图文证据", "Evidence is temporarily unavailable")}</strong><p>{error || pick("地点详情仍可继续使用，稍后可以重试。", "Place details remain available; try again later.")}</p><button type="button" onClick={onReloadNodeEvidence}><ArrowsClockwise />{pick("重试", "Retry")}</button></div></section>;
  const isShareBundle = bundle.sources?.some((source) => source.sourceType === "user_supplied_public_share_link");
  const languageKey = (value) => String(value || "").toLowerCase().split("-")[0];
  const desiredLanguage = locale === "en" ? "en" : "zh";
  const translationNeeded = bundle.sections?.some((section) => section.originalLanguage && languageKey(section.originalLanguage) !== desiredLanguage);
  const translatedToDesired = bundle.translationStatus === "translated" && languageKey(bundle.targetLanguage) === desiredLanguage;
  const localizedSectionLabel = (label) => locale === "en" ? ({ 地点概览: "Place overview", 来源事实: "Source facts", 位置与到达: "Location and access", 价格线索: "Price evidence", 营业时间: "Opening hours", 排队与等待: "Queues and waits", 当地特色: "Local character", 设施与可达性: "Facilities and accessibility", 路线与移动: "Routes and mobility", 事实线索: "Evidence note", 公开可见内容: "Publicly visible content" }[label] ?? label) : label;
  const localizedFixedEvidenceCopy = (value) => {
    if (locale !== "en") return value;
    const exact = {
      "地点坐标已归一化，可以加入现有路线试排。": "The place has normalized coordinates and can enter the current route draft.",
      "缺少可靠坐标，暂不能进入路线试排。": "Reliable coordinates are missing, so this cannot enter the route draft yet.",
      "当前实体尚未取得可用于路线试排的可靠坐标。": "This place does not yet have coordinates reliable enough for route drafting.",
      "当前只有来源资料，尚未形成可追溯的事实 Claim。": "Only source material is available; no traceable factual claim has been formed yet.",
      "外宾住宿资格仍待酒店或授权平台确认。": "Foreign-guest eligibility still needs confirmation from the hotel or an authorized platform.",
      "公开内容不代表来源独立、无商业倾向或当前仍有效。": "Public content does not prove source independence, lack of commercial bias or current validity.",
      "受限正文未读取。": "Restricted body text was not read.",
      "来源资料按核验时间展示；价格、营业、设施和可预订性仍以来源页或现场为准。": "Evidence is shown with its checked time; price, opening, facilities and bookability still depend on the source page or on-site confirmation.",
      "分享内容是不可信输入，不会作为 Agent 指令，也不会自动写入旅行事实。": "Shared content is untrusted input. It never becomes an Agent instruction or an automatic trip fact.",
      "来源图片仅提供回到原页面查看，不在产品内二次展示。": "Source-only images remain on the original page and are not republished here.",
      "少走路": "Less walking",
    }[value];
    return exact ?? value;
  };
  const translatedDecisionSummary = bundle.sections?.find((section) => section.translatedText && section.claimRefs?.some((claimRef) => bundle.decisionFit?.claimRefs?.includes(claimRef)))?.translatedText
    ?? bundle.sections?.find((section) => section.translatedText)?.translatedText
    ?? null;
  const decisionSummary = translatedToDesired && translatedDecisionSummary ? translatedDecisionSummary : localizedFixedEvidenceCopy(bundle.decisionFit?.summary);
  const openOriginalSource = (event, source) => {
    if (!window.travelDesktop || source.sourceType !== "user_supplied_public_share_link") return;
    event.preventDefault();
    void window.travelDesktop.openEvidenceSource(source.sourceUrl);
  };
  const evidenceCheckedAt = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? pick("核验时间待补", "Check time pending") : `${new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)} ${pick("核验", "checked")}`; };
  const sourceOnlyMedia = bundle.media?.filter((media) => !media.displayUrl && media.sourceUrl) ?? [];
  const displayMedia = bundle.media?.filter((media) => media.displayUrl) ?? [];
  const canTrial = Boolean(onTrialCandidate) && bundle.decisionFit?.routeEligible && !node.selected;
  return <div className="evidence-companion-panel">
    {error ? <div className="evidence-companion-inline-error" role="alert"><WarningCircle weight="fill" /><span>{error}</span></div> : null}
    <section className={`evidence-companion-summary ${bundle.status}`}>
      <span><Globe weight="duotone" /></span><div><small>{pick("图文证据伴侣", "Evidence companion")}</small><h2>{bundle.sources?.[0]?.title || node.title}</h2><p>{decisionSummary}</p></div>
      <em>{bundle.status === "ready" ? pick("可追溯", "Traceable") : bundle.status === "login_required" ? pick("需登录来源", "Source login needed") : pick("部分资料", "Partial")}</em>
    </section>
    {displayMedia.length ? <figure className={`evidence-media-grid count-${Math.min(displayMedia.length, 4)}`}>{displayMedia.slice(0, 4).map((media) => <img key={media.mediaId} src={media.displayUrl} alt={media.alt} loading="lazy" referrerPolicy="no-referrer" />)}<figcaption>{pick("仅展示已有显示授权的来源图片", "Only source images with display permission are shown")}</figcaption></figure> : null}
    <section className="evidence-companion-section evidence-reading">
      <header><div><Sparkle weight="duotone" /></div><span><strong>{pick("快速看懂", "Quick read")}</strong><small>{pick("原文、翻译和事实线索分层展示", "Original text, translation and claims stay distinct")}</small></span>{translationNeeded && !translatedToDesired ? <button type="button" onClick={onTranslate} disabled={translating}>{translating ? <CircleNotch className="spin" /> : <Globe />}{locale === "en" ? "Translate to English" : "翻译为中文"}</button> : translatedToDesired ? <em className="evidence-translated-state"><CheckCircle weight="fill" />{pick("已翻译", "Translated")}</em> : null}</header>
      {bundle.translationStatus === "translation_unavailable" ? <p className="evidence-inline-warning"><WarningCircle weight="fill" />{pick("翻译暂时不可用，原文已保留。", "Translation is unavailable; the original text is preserved.")}</p> : null}
      {bundle.sections?.length ? <div className="evidence-sections">{bundle.sections.map((section) => <article key={section.sectionId}><small>{localizedSectionLabel(section.label)}</small>{section.translatedText ? <><p className="translated">{section.translatedText}</p><details><summary>{pick("查看原文", "View original")}</summary><p>{section.originalText}</p></details></> : <p>{section.originalText}</p>}</article>)}</div> : <p className="evidence-empty-copy">{pick("当前公开页面没有可读取正文；不会绕过登录或风控。", "No public body text is available; login or platform controls will not be bypassed.")}</p>}
    </section>
    {bundle.claimGroups?.length ? <section className="evidence-companion-section evidence-claims"><header><div><CheckCircle weight="duotone" /></div><span><strong>{pick("哪些信息有依据", "What the evidence supports")}</strong><small>{pick("同源转载不会被算成多数", "Reposts from the same source are not counted as a majority")}</small></span></header><div>{bundle.claimGroups.map((group) => { const translatedClaims = group.claimRefs.map((claimRef) => bundle.sections.find((section) => section.claimRefs?.includes(claimRef))?.translatedText).filter(Boolean); const summary = translatedClaims.length ? translatedClaims.join("; ") : group.summary; return <article key={group.groupId}><span><strong>{summary}</strong><small>{pick(`${group.independentSourceCount} 个独立来源`, `${group.independentSourceCount} independent source${group.independentSourceCount === 1 ? "" : "s"}`)}</small></span>{group.repeatedSourceCount ? <em>{pick(`${group.repeatedSourceCount} 条可能同源`, `${group.repeatedSourceCount} possibly repeated`)}</em> : null}</article>; })}</div></section> : null}
    <section className="evidence-companion-section evidence-decision-fit"><header><div><MapTrifold weight="duotone" /></div><span><strong>{pick("对这趟旅行有什么用", "How this helps this trip")}</strong><small>{localizedFixedEvidenceCopy(bundle.decisionFit.routeReason)}</small></span></header>{bundle.decisionFit.travelerImpacts?.length ? <ul>{bundle.decisionFit.travelerImpacts.map((impact) => <li key={impact}><Heart weight="fill" />{localizedFixedEvidenceCopy(impact)}</li>)}</ul> : null}{bundle.decisionFit.unknowns?.length ? <div className="evidence-unknowns">{bundle.decisionFit.unknowns.map((unknown) => <p key={unknown}><WarningCircle weight="fill" />{localizedFixedEvidenceCopy(unknown)}</p>)}</div> : null}<button type="button" className="button primary evidence-trial-action" onClick={onTrialCandidate} disabled={!canTrial}><MapTrifold />{node.selected ? pick("已在当前旅行中", "Already in this trip") : canTrial ? pick("加入路线试排", "Add to route draft") : pick("暂不能加入路线", "Not route-ready")}</button></section>
    <section className="evidence-companion-section evidence-sources"><header><div><LinkSimple weight="duotone" /></div><span><strong>{pick("来源与新鲜度", "Sources and freshness")}</strong><small>{pick("每条资料都保留访问边界和核验时间", "Each source keeps its access boundary and checked time")}</small></span></header><div>{bundle.sources?.map((source) => <article key={source.contentItemId}><span><strong>{source.title || consumerProviderLabel(source.provider)}</strong><small>{consumerProviderLabel(source.provider)} · {evidenceCheckedAt(source.checkedAt)}</small></span>{source.sourceUrl ? <a href={source.sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => openOriginalSource(event, source)}>{source.sourceType === "user_supplied_public_share_link" ? (window.travelDesktop ? pick("同窗打开原文", "Open beside companion") : pick("打开原文", "Open original")) : pick("来源说明", "Source notes")}<NavigationArrow /></a> : <em>{source.access === "login_required" ? pick("来源要求登录", "Login required") : pick("无公开跳转", "No public link")}</em>}</article>)}</div>{sourceOnlyMedia.length ? <p className="evidence-source-only"><ImageSquare />{pick("来源图片因显示权限制未在此处复制；请回到原页面查看。", "Source images are not copied here because display rights are not available; view them on the source page.")}</p> : null}</section>
    <section className="evidence-share-link"><div><LinkSimple weight="duotone" /><span><strong>{pick("补充一条你看到的旅行分享", "Add a travel share link")}</strong><small>{pick("只读取公开可见部分，不使用你的 Cookie 或平台账号。", "Only public content is read; your cookies and platform account are never used.")}</small></span></div><form onSubmit={onResolveShare}><input type="url" required value={shareUrl} onChange={(event) => onShareUrlChange(event.target.value)} placeholder={pick("粘贴小红书、抖音或微信文章链接", "Paste a Xiaohongshu, Douyin or WeChat article link")} /><button type="submit" disabled={resolvingShare}>{resolvingShare ? <CircleNotch className="spin" /> : <NavigationArrow />}{pick("读取公开部分", "Read public part")}</button></form>{isShareBundle ? <button type="button" className="quiet-action evidence-return-node" onClick={onReloadNodeEvidence}><ArrowCounterClockwise />{pick("返回地点已有证据", "Return to place evidence")}</button> : null}</section>
    <footer className="evidence-companion-caveats">{bundle.caveats?.map((caveat) => <p key={caveat}><Info weight="fill" />{localizedFixedEvidenceCopy(caveat)}</p>)}</footer>
  </div>;
}

function PlaceDetailSheet({ node, plan, tripId, unavailable = false, onClose: closeSheet, onSubmitFeedback, onTrialCandidate, onPlanPhoto }) {
  const { locale, pick } = useUiLocale();
  const closeRef = useRef(null);
  const scrollRef = useRef(null);
  const detailScrollTopRef = useRef(0);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [view, setView] = useState("detail");
  const [journalDirty, setJournalDirty] = useState(false);
  const mayLeaveJournal = () => !journalDirty || window.confirm(pick("放弃尚未保存的照片和备注？", "Discard unsaved photos and notes?"));
  const onClose = () => { if (mayLeaveJournal()) closeSheet(); };
  const openJournal = () => { setView("journal"); if (scrollRef.current) scrollRef.current.scrollTop = 0; };
  const [evidence, setEvidence] = useState(null);
  const [evidenceState, setEvidenceState] = useState({ loading: false, error: null, translating: false, resolvingShare: false });
  const [shareUrl, setShareUrl] = useState("");
  useEffect(() => {
    if (!node) return undefined;
    setSummaryExpanded(false);
    setView("detail");
    setEvidence(null);
    setEvidenceState({ loading: false, error: null, translating: false, resolvingShare: false });
    setShareUrl("");
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    return undefined;
  }, [node?.nodeId]);
  if (!node) return null;
  const evidenceLanguage = locale === "en" ? "en" : "zh-CN";
  const loadEvidence = async () => {
    setEvidenceState((current) => ({ ...current, loading: true, error: null }));
    try {
      setEvidence(await api.evidenceForNode(tripId, node.nodeId, evidenceLanguage));
      setEvidenceState((current) => ({ ...current, loading: false, error: null }));
    } catch (error) {
      setEvidenceState((current) => ({ ...current, loading: false, error: error?.code === "evidence_node_not_found" ? pick("这个候选已经更新，请关闭后重新打开。", "This option changed; close and reopen it.") : pick("证据服务暂时不可用，请稍后重试。", "Evidence is temporarily unavailable. Try again later.") }));
    }
  };
  const openEvidence = () => {
    detailScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    setView("evidence");
    if (!evidence && !evidenceState.loading) void loadEvidence();
  };
  const openSense = () => {
    detailScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    setView("sense");
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const returnToDetail = () => {
    if (!mayLeaveJournal()) return;
    setView("detail");
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = detailScrollTopRef.current; });
  };
  const translateEvidence = async () => {
    if (!evidence) return;
    setEvidenceState((current) => ({ ...current, translating: true, error: null }));
    try {
      setEvidence(await api.translateEvidenceBundle(tripId, evidence.bundleId, evidenceLanguage));
    } catch {
      setEvidenceState((current) => ({ ...current, error: pick("翻译暂时没有完成，原文仍可查看。", "Translation did not complete; the original remains available.") }));
    } finally {
      setEvidenceState((current) => ({ ...current, translating: false }));
    }
  };
  const resolveShare = async (event) => {
    event.preventDefault();
    setEvidenceState((current) => ({ ...current, resolvingShare: true, error: null }));
    try {
      setEvidence(await api.resolveEvidenceShareLink(tripId, node.nodeId, shareUrl, evidenceLanguage));
      setShareUrl("");
    } catch (error) {
      const copy = error?.code === "TERMS_BLOCKED" ? pick("该链接不在当前支持的公开来源范围内。", "This link is outside the supported public sources.") : error?.code === "RATE_LIMITED" ? pick("来源当前限流，请稍后再试。", "The source is rate-limited. Try again later.") : pick("没有读取到可核验的公开内容；不会绕过登录或风控。", "No verifiable public content was available; login or platform controls will not be bypassed.");
      setEvidenceState((current) => ({ ...current, error: copy }));
    } finally {
      setEvidenceState((current) => ({ ...current, resolvingShare: false }));
    }
  };
  const detail = node.operability ?? {};
  const meta = domainMeta(node.domain);
  const facilities = detail.mappedFacilities ?? [];
  const location = node.location?.address || node.location?.label || node.location?.district || "位置资料待补";
  const mobilityPlace = (plan?.mobility?.legs ?? []).flatMap((leg) => [leg.origin, leg.destination])
    .find((place) => place?.nodeId === node.nodeId && Number.isFinite(place?.coordinates?.longitude) && Number.isFinite(place?.coordinates?.latitude));
  const mappedNode = Number.isFinite(node.location?.coordinates?.longitude) && Number.isFinite(node.location?.coordinates?.latitude)
    ? node
    : mobilityPlace
      ? { ...node, location: { ...(node.location ?? {}), label: node.location?.label || mobilityPlace.label, coordinates: mobilityPlace.coordinates } }
      : node;
  const mapUrl = amapMarkerUrl(mappedNode);
  const detailPrice = normalizedUiPrice(node);
  const facts = [
    detailPrice.amount != null ? { label: detailPrice.quality === "firm" ? "本次实价" : detailPrice.quality === "estimate" ? "确定性估算" : "参考价格", value: `${detailPrice.quality === "reference" ? "≈" : detailPrice.quality === "estimate" ? "~" : ""}¥${new Intl.NumberFormat("zh-CN").format(detailPrice.amount)}${detailPrice.basis ? ` · ${localizedPriceBasis(detailPrice.basis)}` : ""}` } : null,
    detail.rating ? { label: "来源评分", value: String(detail.rating) } : null,
    detail.roomName ? { label: "房型", value: detail.roomName } : null,
    detail.roomArea ? { label: "房间面积", value: detail.roomArea } : null,
    detail.roomWindow ? { label: "窗户", value: detail.roomWindow } : null,
    detail.meal ? { label: "早餐", value: detail.meal } : null,
    detail.refundPolicy ? { label: "退改", value: detail.refundPolicy } : null,
  ].filter(Boolean);
  const sourceLabel = consumerProviderLabel(detail.sourceLabel || detail.bookingProviderLabel || "旅行资料来源");
  const longSummary = String(node.summary ?? "").length > 320;
  const headerLabel = view === "journal" ? pick("我的旅行手账", "My travel journal") : view === "evidence" ? pick("图文证据", "Evidence") : view === "sense" ? pick("地点手账", "Place notebook") : `${meta.label}的详情`;
  const headerSubcopy = view === "evidence"
    ? pick("原文、来源、翻译与旅行适配", "Original, source, translation and trip fit")
    : view === "journal" ? pick("照片、旅行记录与下一次灵感", "Photos, memories and your next idea") : view === "sense"
      ? pick("风格化小世界、来源线索与路线试排", "An illustrated world, source clues and route drafting")
      : `${sourceLabel} · ${formatCheckedAt(detail.checkedAt)}`;
  return <OverlaySurface overlayClassName={`place-detail-overlay${view === "sense" ? " destination-sense-overlay" : ""}`} surfaceClassName={`place-detail-sheet${view === "sense" ? " destination-sense-sheet" : ""}`} labelledBy={view === "detail" ? "place-detail-title" : undefined} label={view === "journal" ? pick(`${node.title}旅行手账`, `Travel journal for ${node.title}`) : view === "sense" ? pick(`走进${node.title}`, `Step into ${node.title}`) : view === "evidence" ? pick(`${node.title}图文证据`, `Evidence for ${node.title}`) : undefined} onClose={onClose} initialFocusRef={closeRef}>
      <header className={`place-detail-header ${view !== "detail" ? "evidence-mode" : ""}`}><div>{view !== "detail" ? <button type="button" className="evidence-back" onClick={returnToDetail}><NavigationArrow />{pick("地点详情", "Place details")}</button> : null}<span className="detail-domain">{view === "evidence" ? <Globe weight="duotone" /> : view === "sense" ? <MapTrifold weight="duotone" /> : <meta.icon weight="duotone" />}{headerLabel}</span><small>{headerSubcopy}</small></div><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭地点详情"><X /></button></header>
      <div ref={scrollRef} className="place-detail-scroll">
        {unavailable ? <p className="journey-stale-place" role="status">{pick("这个候选已更新。这里保留打开时的资料和未保存内容，但不能再加入试排；保存新照片时可能需要重新选择地点。", "This option has changed. Your open details and unsaved work are kept, but it can no longer be drafted. New photos may require a current place.")}</p> : null}
        {view === "journal" ? <Suspense fallback={<p role="status">{pick("正在打开手账…", "Opening journal…")}</p>}><LazyTravelPhotoJournal key={node.nodeId} node={node} tripId={tripId} locale={locale} onPlanPhoto={onPlanPhoto} onDirtyChange={setJournalDirty} /></Suspense> : view === "evidence" ? <EvidenceCompanionPanel bundle={evidence} loading={evidenceState.loading} error={evidenceState.error} node={node} shareUrl={shareUrl} onShareUrlChange={setShareUrl} onResolveShare={resolveShare} onReloadNodeEvidence={loadEvidence} onTranslate={translateEvidence} translating={evidenceState.translating} resolvingShare={evidenceState.resolvingShare} onTrialCandidate={onTrialCandidate} /> : view === "sense" ? <Suspense fallback={<section className="evidence-companion-state" role="status"><CircleNotch className="spin" /><div><strong>{pick("正在展开地点手账", "Opening the place notebook")}</strong><p>{pick("正在准备可探索的小世界。", "Preparing an explorable little world.")}</p></div></section>}><LazyDestinationExperiencePreview node={mappedNode} plan={plan} locale={locale} onTrialCandidate={onTrialCandidate} onOpenEvidence={openEvidence} onOpenJournal={openJournal} /></Suspense> : <>
        {node.media?.length ? <figure className={`place-gallery count-${Math.min(node.media.length, 4)}`}>{node.media.slice(0, 4).map((media, index) => <img key={`${media.url}-${index}`} src={media.url} alt={media.title || `${node.title}实景图 ${index + 1}`} loading="eager" referrerPolicy="no-referrer" />)}<figcaption>{node.media.length === 1 ? "当前来源返回 1 张实景图" : `当前来源返回 ${node.media.length} 张实景图`}</figcaption></figure> : <div className="detail-media-missing"><MapPin weight="duotone" /><span><strong>当前来源没有返回图片</strong><small>不会用通用风景图替代这个地点。</small></span></div>}
        <section className="place-detail-intro"><span className="detail-domain"><meta.icon weight="duotone" />{meta.label}</span><h2 id="place-detail-title">{node.title}</h2><p className={summaryExpanded ? "expanded" : ""}>{node.summary || "当前来源只返回了地点名称和位置。"}</p>{longSummary ? <button type="button" className="detail-text-toggle" onClick={() => setSummaryExpanded((current) => !current)}>{summaryExpanded ? "收起介绍" : "展开完整介绍"}<CaretDown className={summaryExpanded ? "expanded" : ""} /></button> : null}</section>
        <nav className="journey-place-tools" aria-label={pick("探索和记录这个地点", "Explore and remember this place")}>
          <button type="button" onClick={openSense}><Compass weight="duotone" /><strong>{pick("先感受这里", "Explore in 3D")}</strong><small>{pick("风格化场景预览", "Illustrated scene")}</small></button>
          <button type="button" onClick={openEvidence}><Globe weight="duotone" /><strong>{pick("看看真实资料", "Check the evidence")}</strong><small>{pick("图文来源与翻译", "Sources & translation")}</small></button>
          <button type="button" onClick={openJournal}><ImageSquare weight="duotone" /><strong>{pick("留下旅行记录", "Save a memory")}</strong><small>{pick("景色与建筑照片 · 立体预览", "Scenery & architecture · photo depth")}</small></button>
        </nav>
        {facts.length ? <section className="detail-facts" aria-label="地点关键信息">{facts.map((fact) => <div key={fact.label}><small>{fact.label}</small><strong>{fact.value}</strong></div>)}</section> : null}
        {node.domain === "transport" ? <section className="detail-section transport-detail"><header><div><Train weight="duotone" /></div><span><strong>班次、到达点与票价</strong><small>跨城库存来自 OTA；市内接驳由高德路线补齐</small></span></header><TransportSnapshot detail={detail} /></section> : null}
        <section className="detail-section location-detail"><header><div><MapTrifold weight="duotone" /></div><span><strong>{node.domain === "transport" ? "到达点与地图" : "位置与地图"}</strong><small>{node.domain === "transport" ? detail.arrivalPlace?.label || detail.arrivalRouteAnchor?.label || "到达点待核验" : location}</small></span></header><TripDecisionMap nodes={[mappedNode]} activeNodeId={node.nodeId} onFocusNode={() => {}} tripId={tripId} staticMapAvailable={false} label={`${node.title}的位置地图`} /><p className="detail-map-scope">{mapUrl ? "这里只显示当前地点；候选之间的完整路线请回到方案工作台查看。" : "当前实体尚未解析出可靠坐标；地址会保留，但不会据此声称位置方便。"}</p>{mapUrl ? <a className="detail-primary-link" href={mapUrl} target="_blank" rel="noreferrer"><NavigationArrow />在高德查看这个地点</a> : null}</section>
        <section className="detail-section facilities-detail"><header><div><Elevator weight="duotone" /></div><span><strong>设施与可达性</strong><small>{facilities.length ? "地图资料，非实时，建议现场确认" : "当前来源尚未返回设施资料"}</small></span></header>{detail.requestedFacilityNeeds?.length ? <div className="facility-evidence-status"><span><b>这次旅行需要</b>{detail.requestedFacilityNeeds.join("；")}</span><span><b>当前已取得</b>{facilities.length ? facilities.map((facility) => facility.label).join("、") : "尚无可用设施记录"}</span><span><b>到场前仍要确认</b>设施是否开放、正常运行，以及是否能形成连续无台阶路线</span></div> : null}<FacilityReferences facilities={facilities} emptyText={node.domain === "stay" ? `当前酒店来源只返回了图片、位置和${detailPrice.quality === "firm" ? "本次报价快照" : detailPrice.quality === "reference" ? "参考价格" : "价格线索"}；电梯、停车、早餐、卫生间等设施仍需核验。` : "当前来源没有返回卫生间、电梯、坡道或储物设施；不代表现场没有，出发前仍需核验。"} />{detail.indoorMap || detail.indoor ? <p className="facility-note">已取得室内或楼层相关资料；入口、楼层和开放情况仍以现场为准。</p> : null}{detail.bookingUrl ? <a className="detail-primary-link" href={detail.bookingUrl} target="_blank" rel="noreferrer"><NavigationArrow />在{detail.bookingProviderLabel || "供应方"}查看完整图片与设施</a> : node.domain === "stay" ? <p className="detail-handoff-unavailable">当前只能比较这份住宿资料，尚未取得可用的库存详情或预订交接链接。</p> : null}</section>
        {["food", "play", "stay"].includes(node.domain) ? <VisitFeedbackSection node={node} onSubmit={onSubmitFeedback} /> : null}
        <section className="detail-source-note"><WarningCircle weight="fill" /><p>{acceptedSourceLabel(node)}。图片、价格、房态、营业状态和设施信息以跳转页或现场为准。</p></section>
        </>}
      </div>
  </OverlaySurface>;
}

function WeatherPlanningCard({ weather, onEdit }) {
  if (!weather) return <section className="weather-card pending editable-weather"><CloudSun weight="duotone" /><div><strong>天气待核验</strong><p>生成方案时会先核验旅行日期与目的地天气，再安排户外体验、换乘缓冲、住宿和餐饮动线。</p></div><button type="button" onClick={() => onEdit?.("我想补充具体旅行日期：", "旅行日期")}>补充日期<PaperPlaneRight /></button></section>;
  const coverageLabel = weather.coverage === "covered" ? "覆盖旅行日期" : weather.coverage === "partial" ? "覆盖部分日期" : weather.coverage === "outside_forecast_window" ? "尚未进入预报期" : "旅行日期待明确";
  const title = weather.planningImpact?.active
    ? "天气正在影响这版方案"
    : weather.coverage === "outside_forecast_window"
      ? "还没到可预报范围"
      : weather.coverage === "dates_unknown"
        ? "日期明确后核验天气"
        : "当前预报无需调整方案";
  const tripDates = new Set(weather.tripDates ?? []);
  const days = ["covered", "partial"].includes(weather.coverage)
    ? (weather.forecastDays ?? []).filter((day) => tripDates.has(day.date)).slice(0, 4)
    : [];
  const datePrompt = weather.coverage === "dates_unknown" || weather.coverage === "outside_forecast_window" ? "我想补充具体旅行日期：" : "我想调整旅行日期，目前计划是：";
  return <section className={`weather-card ${weather.planningImpact?.severity ?? "none"} editable-weather`}>
    <header><span><CloudSun weight="duotone" /></span><div><strong>{title}</strong><p>{weather.city || weather.destination}，{coverageLabel}{weather.reportTime ? `，${weather.reportTime} 发布` : ""}</p></div><button type="button" onClick={() => onEdit?.(datePrompt, "旅行日期与天气")}>{weather.coverage === "dates_unknown" ? "补充日期" : "调整日期"}<PaperPlaneRight /></button></header>
    {days.length ? <div className="weather-days">{days.map((day) => <div key={day.date}><small>{day.date.slice(5).replace("-", "/")}</small><strong>{day.dayCondition || "天气待定"}</strong><span>{day.highC ?? "-"}° / {day.lowC ?? "-"}°</span></div>)}</div> : null}
    {weather.planningImpact?.active ? <div className="weather-guidance">{DOMAIN_ITEMS.map(({ key, label }) => weather.planningImpact.guidance?.[key] ? <p key={key}><strong>{label}</strong>{weather.planningImpact.guidance[key]}</p> : null)}</div> : weather.caveat ? <p className="weather-caveat">{weather.caveat}</p> : null}
    <footer><a href={weather.sourceDocumentation} target="_blank" rel="noreferrer">{weather.attribution || (weather.provider === "amap_weather" ? "高德天气" : "天气来源")} · {formatCheckedAt(weather.checkedAt)}</a></footer>
  </section>;
}

const MOBILITY_MODE_LABELS = Object.freeze({ walk: "步行", transit: "公交 / 地铁", taxi: "打车" });

function MobilityPlanningCard({ mobility, activeLegId, onSelectLeg }) {
  if (!mobility) return null;
  if (!["completed", "partial"].includes(mobility.status)) {
    const title = mobility.status === "needs_context" ? "还不能核验城市内移动" : "城市路线资料暂不可用";
    const detail = mobility.reason === "selected_places_changed"
      ? "地点选择刚刚变化，路线需要重新计算。"
      : mobility.reason === "at_least_two_selected_places_required"
        ? "至少确认两个地点后，才能比较步行、公交地铁和打车。"
        : "暂时无法取得高德城市路线资料；当前不会用地点信息冒充真实路线。";
    return <section className="mobility-card pending"><Train weight="duotone" /><div><strong>{title}</strong><p>{detail}</p></div></section>;
  }
  const activeLeg = mobility.legs.find((leg) => leg.legId === activeLegId) ?? mobility.legs[0];
  const recommended = activeLeg?.alternatives.find((alternative) => alternative.mode === activeLeg.recommendedMode);
  const routeAudit = activeLeg?.recommendationAudit ?? null;
  const features = recommended?.accessibilityFeatures ?? [];
  return <section className={`mobility-card ${mobility.status}`} aria-labelledby="mobility-card-title">
    <header><span><Train weight="duotone" /></span><div><strong id="mobility-card-title">已选地点之间怎么走</strong><p>{mobility.status === "partial" ? "部分路线仍待补齐" : "已完成城市移动核验"} · 不是实时到站或即时叫车结果</p></div></header>
    {["partial", "unverified"].includes(mobility.travelerFit?.accessibilityEvidence) ? <div className="mobility-care-warning"><WarningCircle weight="fill" /><span>{mobility.travelerFit.accessibilityEvidence === "partial" ? "路线已标出高德资料中的直梯、扶梯、阶梯或斜坡。设施是否正在运行并非实时信息，连续无障碍仍建议现场确认。" : "步行和换乘已按同行人要求比较；本次没有取得足够的直梯、扶梯、阶梯或斜坡资料，连续无障碍仍待确认。"}</span></div> : null}
    {mobility.legs.length > 1 ? <div className="route-selector" role="tablist" aria-label="选择要查看的移动路段">{mobility.legs.map((leg, index) => <button key={leg.legId} type="button" role="tab" aria-selected={leg.legId === activeLeg?.legId} className={leg.legId === activeLeg?.legId ? "active" : ""} onClick={() => onSelectLeg?.(leg.legId)}><small>第 {index + 1} 段</small><span>{leg.origin.label} → {leg.destination.label}</span></button>)}</div> : null}
    {activeLeg ? <div className="active-route-detail">
      <div className="mobility-route"><strong>{activeLeg.origin.label}</strong><NavigationArrow /><strong>{activeLeg.destination.label}</strong></div>
      <div className="mobility-summary"><b>{MOBILITY_MODE_LABELS[activeLeg.recommendedMode] ?? activeLeg.recommendedMode}</b><span>约 {recommended?.totalMinutes ?? "-"} 分钟</span>{recommended?.walkingMeters != null && <span>步行 {Math.round(recommended.walkingMeters)} 米</span>}{recommended?.transfers != null && recommended.mode === "transit" && <span>{recommended.transfers} 次换乘</span>}{recommended?.estimatedFareCny != null && recommended.mode === "taxi" && <span>估价 ¥{recommended.estimatedFareCny}</span>}</div>
      {routeAudit ? <section className="route-audit" aria-label="交通方式比较依据"><header><strong>为什么这样推荐</strong><small>当前目标：步行 ≤ {routeAudit.thresholds?.walkingMeters ?? "待定"} 米 · 换乘 ≤ {routeAudit.thresholds?.transfers ?? "待定"} 次</small></header><div>{routeAudit.transit ? <span><b>公交 / 地铁</b><em>{routeAudit.transit.totalMinutes} 分钟 · 步行 {Math.round(routeAudit.transit.walkingMeters ?? 0)} 米 · {routeAudit.transit.transfers ?? 0} 次换乘 · 约 ¥{Math.round(routeAudit.transit.estimatedFareCny ?? 0)}</em></span> : null}{routeAudit.taxi ? <span><b>打车</b><em>{routeAudit.taxi.totalMinutes} 分钟 · 步行 {Math.round(routeAudit.taxi.walkingMeters ?? 0)} 米 · {routeAudit.taxi.transfers ?? 0} 次换乘 · 约 ¥{Math.round(routeAudit.taxi.estimatedFareCny ?? 0)}</em></span> : null}{routeAudit.walk ? <span><b>步行</b><em>{routeAudit.walk.totalMinutes} 分钟 · {Math.round(routeAudit.walk.distanceMeters ?? 0)} 米</em></span> : null}</div>{routeAudit.accessibilityEvidence?.status === "not_verified" ? <p><WarningCircle weight="fill" />连续无台阶与电梯运行状态仍待核验；这不等于已发现楼梯冲突。</p> : null}</section> : null}
      <div className="route-facility-section"><h4>这段路可参考的设施</h4><FacilityReferences facilities={features} emptyText="这段路线没有返回电梯、扶梯、楼梯或坡道资料；不代表现场没有。" /></div>
      <p>{activeLeg.rationale}</p>
      {recommended?.steps?.length ? <details><summary>查看上车、换乘和步行</summary><ol>{recommended.steps.map((step, index) => <li key={`${activeLeg.legId}-${index}`}><strong>{step.line || MOBILITY_MODE_LABELS[step.kind] || "路段"}</strong><span>{step.instruction}</span>{step.accessibilityFeatures?.length ? <small className="step-facility">{step.accessibilityFeatures.map((feature) => feature.label).join("、")} · 地图路线资料，非实时，现场确认</small> : null}</li>)}</ol></details> : null}
      {recommended?.navigationUrl && <a className="route-navigation-link" href={recommended.navigationUrl} target="_blank" rel="noreferrer"><NavigationArrow />在高德继续导航</a>}
    </div> : null}
    <footer><span>{formatCheckedAt(mobility.checkedAt)} · {mobility.coverage?.unscheduled ? "日程时段确定后会重新计算" : "已按日程时段查询"}</span>{mobility.sourceDocumentation ? <a href={mobility.sourceDocumentation} target="_blank" rel="noreferrer">高德路线资料说明</a> : null}</footer>
  </section>;
}

function PlanQualityNotice({ qa }) {
  const messages = [];
  if (qa?.operabilityGaps?.some((gap) => gap.code === "city_mobility_unverified")) messages.push("已选地点之间的步行、公交地铁与打车路线尚未核验，当前不能称为可执行日程。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "city_mobility_partial")) messages.push("只有部分城市移动路段完成核验，未覆盖路段仍需补齐。");
  if (qa?.hardConstraintViolations?.some((gap) => gap.code === "foreign_guest_stay_unverified")) messages.push("住宿的外宾接待资格尚未核验，入境游客暂不能进入预订跳转。");
  if (qa?.hardConstraintViolations?.some((gap) => gap.code === "traveler_walk_limit_exceeded")) messages.push("当前建议路线超过某位同行人的单段步行上限，需要换交通方式或调整地点顺序。");
  if (qa?.hardConstraintViolations?.some((gap) => gap.code === "traveler_transfer_limit_exceeded")) messages.push("当前建议路线超过某位同行人的换乘上限，需要改用更直接的路线。");
  if (qa?.hardConstraintViolations?.some((gap) => gap.code === "traveler_stairs_route_conflict")) messages.push("当前建议路线资料中含阶梯，与同行人的避开台阶要求冲突，需要更换路线或交通方式。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "traveler_step_free_route_unverified")) messages.push("需要避开台阶的同行人，其车站电梯、出入口和连续无障碍路线尚未核验。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "traveler_accessible_toilet_unverified")) messages.push("有同行人需要无障碍卫生间，当前地点与沿途设施尚未取得可靠核验。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "traveler_pacing_unverified")) messages.push("休息间隔和连续活动时长尚未排入每天的节奏。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "traveler_meal_timing_unverified")) messages.push("同行人的最晚晚餐时间尚未排入餐饮与返程动线。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "traveler_food_exclusions_unverified")) messages.push("餐饮候选尚未逐项核验同行人的饮食排除项。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "traveler_sensory_fit_unverified")) messages.push("活动的人流或感官刺激程度尚未核验是否适合相关同行人。");
  if (qa?.operabilityGaps?.some((gap) => gap.code === "weather_mitigation_required")) messages.push("已选户外体验受高风险天气影响，需要保留室内替代或调整时段。");
  if (qa?.budget?.exceedsBudget) messages.push("当前已选方案超过总预算，需要调整后再准备预订。");
  if (!messages.length) return null;
  return <div className="canvas-warning plan-quality"><WarningCircle weight="fill" /><div><strong>还有可执行性信息待补齐</strong>{messages.map((message) => <p key={message}>{message}</p>)}</div></div>;
}

function travelerCareLabels(traveler) {
  const care = traveler?.careNeeds ?? {};
  const labels = [];
  if (care.mobility?.maxContinuousWalkMeters != null) labels.push(`单段步行≤${care.mobility.maxContinuousWalkMeters}米`);
  else if (care.mobility?.reduceWalking) labels.push("需要少走路");
  if (care.mobility?.maxTransfers != null) labels.push(`最多换乘${care.mobility.maxTransfers}次`);
  if (care.mobility?.stepFreeRequired) labels.push("需要连续无台阶");
  else if (care.mobility?.avoidStairs) labels.push("尽量避开楼梯");
  if (care.mobility?.wheelchairSpaceRequired) labels.push("需要轮椅空间");
  if (care.mobility?.luggageAssistanceRequired) labels.push("减少搬运行李");
  if (care.stamina?.restEveryMinutes != null) labels.push(`每${care.stamina.restEveryMinutes}分钟休息`);
  else if (care.stamina?.needsFrequentRest) labels.push("需要频繁休息");
  if (care.stamina?.maxActiveMinutesPerBlock != null) labels.push(`连续活动≤${care.stamina.maxActiveMinutesPerBlock}分钟`);
  if (care.schedule?.earliestStartTime) labels.push(`${care.schedule.earliestStartTime}后出发`);
  if (care.schedule?.latestReturnTime) labels.push(`${care.schedule.latestReturnTime}前返回`);
  if (care.schedule?.latestDinnerTime) labels.push(`晚饭不晚于${care.schedule.latestDinnerTime}`);
  if (care.facilities?.accessibleToiletRequired) labels.push("需核验无障碍卫生间");
  else if (care.facilities?.toiletAccessPriority) labels.push("优先卫生间便利");
  if (care.facilities?.nursingRoomRequired) labels.push("需要母婴室");
  if (care.facilities?.strollerFriendlyRequired) labels.push("婴儿车友好");
  if (care.facilities?.quietRetreatRequired) labels.push("需要安静休息区");
  if (care.sensory?.avoidCrowds) labels.push("尽量避开拥挤");
  if (care.sensory?.avoidStrongSensoryStimuli) labels.push("减少强噪声/强光");
  if (care.food?.exclusions?.length) labels.push(`饮食避开：${care.food.exclusions.join("、")}`);
  return labels;
}

function TravelerCareSummary({ trip, onEdit }) {
  const travelers = (trip?.travelers ?? []).map((traveler) => ({ ...traveler, labels: travelerCareLabels(traveler) }));
  const specific = travelers.filter((traveler) => traveler.labels.length || traveler.relationship || !/^同行人 \d+$/.test(traveler.displayName ?? ""));
  const facts = [
    { key: "budget", icon: CurrencyCircleDollar, title: trip?.totalBudget != null ? `总预算 ¥${new Intl.NumberFormat("zh-CN").format(trip.totalBudget)}` : "总预算待补", detail: "影响住宿、交通与餐饮取舍", prompt: trip?.totalBudget != null ? `我想调整这趟旅行的总预算，目前是 ¥${new Intl.NumberFormat("zh-CN").format(trip.totalBudget)}。新的预算是：` : "这趟旅行的总预算是：", missing: trip?.totalBudget == null },
    { key: "pace", icon: PersonSimpleWalk, title: trip?.pace ? `整体节奏：${trip.pace}` : "旅行节奏待补", detail: "影响每天强度、步行与休息", prompt: trip?.pace ? `我想调整整趟旅行的节奏，目前是“${trip.pace}”。希望改为：` : "我希望整趟旅行的节奏是：", missing: !trip?.pace },
  ].filter(Boolean);
  return <section className="traveler-care" aria-labelledby="traveler-care-title">
    <header><span><Heart weight="fill" /></span><div><strong id="traveler-care-title">同行人的安排重点</strong><p>点击预算、节奏或某位同行人，会回到对话输入；发送后 Agent 才会更新方案。</p></div></header>
    <div className="trip-fact-actions">{facts.map(({ key, icon: Icon, title, detail, prompt, missing }) => <button key={key} type="button" className={missing ? "missing" : ""} onClick={() => onEdit?.(prompt, key === "budget" ? "旅行预算" : "旅行节奏")}><span><Icon /></span><span><strong>{title}</strong><small>{detail}</small></span><CaretDown /></button>)}</div>
    {specific.length ? <ul>{specific.map((traveler) => {
      const name = traveler.displayName || traveler.relationship || "同行人";
      const existing = traveler.labels.length ? `目前已记录：${traveler.labels.join("、")}；` : "目前还没有额外行动要求；";
      return <li key={traveler.travelerId}><button type="button" className="traveler-edit-row" onClick={() => onEdit?.(`关于${name}的出行要求，${existing}我想补充或调整：`, `${name}的出行要求`)}><span className="traveler-copy"><span><strong>{name}</strong>{traveler.relationship && traveler.relationship !== traveler.displayName ? <em>{traveler.relationship}</em> : null}</span><small>{traveler.labels.length ? traveler.labels.join("，") : "暂无额外行动要求"}</small></span><span className="traveler-edit-label">补充或修改<CaretDown /></span></button></li>;
    })}</ul> : <button type="button" className="care-empty editable" onClick={() => onEdit?.("请分别记录同行人的行动需求，例如谁需要少走路、少换乘、固定休息或特定设施：", "同行人的出行要求")}>还没有分别记录同行人的行动需求<span>现在补充<CaretDown /></span></button>}
  </section>;
}

const READINESS_STATUS_LABELS = Object.freeze({
  ready: "已准备",
  action_required: "需要处理",
  needs_verification: "需要核验",
  blocked: "当前会阻断",
  not_applicable: "本次不适用",
});
const READINESS_STATUS_LABELS_EN = Object.freeze({
  ready: "Ready",
  action_required: "Action needed",
  needs_verification: "Check needed",
  blocked: "Blocks this trip",
  not_applicable: "Not needed",
});

function localizedReadinessItem(item, locale) {
  if (locale !== "en") return item;
  const copy = {
    trip_scope: ["Destination and dates", item.status === "ready" ? "Dates are specific enough to check routes and dated inventory." : "Destination or dates are missing, limiting weather, inventory and daily timing checks.", "Add destination and exact dates"],
    travel_documents: ["Entry and travel documents", "Only the check status is stored. Document numbers and images are not collected.", "Check official requirements for this trip"],
    mobile_access: ["Mobile data and contact access", "Maps, tickets, hotel communication and account recovery depend on working mobile access.", "Confirm roaming, eSIM or another data option"],
    cashless_access: ["Payment and backup method", "Only readiness is stored. Card, account and payment credentials are not collected.", "Confirm a working method and a backup"],
    lodging_eligibility: ["Hotel eligibility for foreign guests", item.status === "ready" ? "The selected stay has supporting eligibility evidence." : item.status === "blocked" ? "Current evidence says this stay is unsuitable for foreign guests." : "Current sources do not prove that the selected stay can accept foreign guests.", item.status === "action_required" ? "Choose a stay first" : "Confirm with the hotel or authorized platform"],
    china_account_continuity: ["Keep this trip available in China", item.status === "action_required" ? "This is a guest trip. Sign in to save it across devices and recover it during the trip." : "The trip is saved. Confirm that one sign-in method will remain usable in China.", item.status === "action_required" ? "Sign in and save" : "Confirm an in-China access method"],
    city_navigation: ["City routes and navigation", item.status === "ready" ? "Route, walking and transfer estimates were checked at the shown time." : "City movement still needs checking after places are confirmed. A planned route is not live arrival data.", "Confirm places and refresh routes"],
  }[item.itemId];
  return copy ? { ...item, title: copy[0], reason: copy[1], action: copy[2] } : item;
}

function readinessPrompt(item, locale = "zh-CN") {
  if (locale === "en") {
    const prompts = {
      trip_scope: "Help me complete the destination and exact dates that matter most for this trip: ",
      lodging_eligibility: "Prioritize stays that can accept foreign guests. Do not treat an option as bookable without eligibility evidence.",
      city_navigation: "After places are confirmed, check city routes, walking, transfers, entrances, exits and facilities that still need on-site confirmation.",
    };
    return prompts[item.itemId] ?? `Help me resolve “${item.title}” before departure. Explain the next step and a trustworthy source.`;
  }
  const prompts = {
    trip_scope: "请帮我补齐这趟旅行最需要的目的地和具体日期：",
    lodging_eligibility: "请优先比较并核验适合外宾入住的住宿；没有资格证据的候选不要当作可订酒店。",
    city_navigation: "请在地点确认后核验市内路线、步行、换乘、入口出口和需要现场确认的设施。",
  };
  return prompts[item.itemId] ?? `请帮我处理出发准备中的“${item.title}”：${item.action || "说明下一步和可信来源"}。`;
}

function ReadinessPanel({ readiness, onUpdate, onAction, onLogin, compact = false }) {
  const { locale, pick } = useUiLocale();
  if (!readiness) return null;
  const items = readiness.items.filter((item) => item.status !== "not_applicable").map((item) => localizedReadinessItem(item, locale));
  const visible = compact ? items.slice(0, 4) : items;
  const attention = items.filter((item) => item.status !== "ready").length;
  return <section className={`readiness-panel ${compact ? "compact" : ""}`} aria-labelledby="readiness-title">
    <header><div><span className="eyebrow">{pick("出发准备", "Before you go")}</span><h3 id="readiness-title">{attention ? (locale === "en" ? `${attention} items can affect this trip` : `${attention} 项会影响这趟旅行`) : pick("这趟旅行已经具备基本执行条件", "This trip has the basic conditions to proceed")}</h3><p>{pick("只显示与本次旅行有关的事项；不在这里收集证件号码、银行卡或账号凭据。", "Only trip-relevant items are shown. Document numbers, cards and account credentials are not collected here.")}</p></div><span className={`readiness-overall ${readiness.status}`}>{readiness.status === "ready" ? pick("已准备", "Ready") : readiness.status === "blocked" ? pick("存在阻断", "Blocked") : pick("继续完善", "Keep preparing")}</span></header>
    <div className="readiness-grid">{visible.map((item) => <article key={item.itemId} className={`readiness-item ${item.status}`}>
      <div className="readiness-item-title"><span>{item.status === "ready" ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}</span><div><strong>{item.title}</strong><small>{(locale === "en" ? READINESS_STATUS_LABELS_EN : READINESS_STATUS_LABELS)[item.status] ?? item.status}</small></div></div>
      <p>{item.reason}</p>
      <footer>
        {item.editable ? <div className="readiness-actions"><button type="button" className={item.status === "ready" ? "selected" : ""} onClick={() => onUpdate?.(item.itemId, "ready")}>{pick("我已准备", "I'm ready")}</button><button type="button" className={item.status === "action_required" ? "selected" : ""} onClick={() => onUpdate?.(item.itemId, "needs_help")}>{pick("需要帮助", "I need help")}</button></div> : item.itemId === "china_account_continuity" && item.status === "action_required" ? <button type="button" className="readiness-primary-action" onClick={onLogin}>{pick("登录保存旅行", "Sign in and save")}</button> : item.action ? <button type="button" className="readiness-primary-action" onClick={() => onAction?.(readinessPrompt(item, locale), item.title)}>{item.action}</button> : null}
        {item.guidanceUrl ? <a href={item.guidanceUrl} target="_blank" rel="noreferrer">{pick("查看官方核对入口", "Open official guidance")}<NavigationArrow /></a> : null}
      </footer>
    </article>)}</div>
    {compact && items.length > visible.length ? <small className="readiness-more">{locale === "en" ? `${items.length - visible.length} more items are available in trip details` : `另有 ${items.length - visible.length} 项可在行程详情继续核对`}</small> : null}
  </section>;
}

function ReadinessStrip({ readiness, onUpdate, onAction, onLogin }) {
  const { locale, pick } = useUiLocale();
  if (!readiness) return null;
  const items = readiness.items.filter((item) => item.status !== "not_applicable").map((item) => localizedReadinessItem(item, locale));
  const attention = items.filter((item) => item.status !== "ready");
  const statusLabel = attention.length
    ? (locale === "en" ? `${attention.length} items before departure` : `出发前还差 ${attention.length} 项`)
    : pick("出发准备已完成", "Ready for departure");
  return <details className={`readiness-strip ${attention.length ? "needs-attention" : "ready"}`}>
    <summary><span className="readiness-strip-icon">{attention.length ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />}</span><span className="readiness-strip-copy"><small>{pick("出发准备", "Before you go")}</small><strong>{statusLabel}</strong></span><span className="readiness-strip-preview">{attention.slice(0, 2).map((item) => <em key={item.itemId}>{item.title}</em>)}</span><span className="readiness-strip-action">{pick("查看清单", "View checklist")}<CaretDown /></span></summary>
    <ReadinessPanel readiness={readiness} onUpdate={onUpdate} onAction={onAction} onLogin={onLogin} compact />
  </details>;
}

function AnalysisCoverageNotice({ analysis, onRetry }) {
  const { pick } = useUiLocale();
  if (!analysis || analysis.coverage === "complete") return null;
  const labels = {
    inventory_budget: pick("价格与库存", "price and inventory"),
    local_discovery: pick("当地体验与来源", "local discovery and sources"),
    operability_schedule: pick("路线、日程与同行人适配", "routes, schedule and traveler fit"),
  };
  const missing = (analysis.requiredLanes ?? []).filter((lane) => !(analysis.completedLanes ?? []).includes(lane)).map((lane) => labels[lane] ?? lane);
  const title = analysis.coverage === "failed" ? pick("本轮深入比较未完成", "Deeper comparison did not complete") : pick("当前是部分分析结果", "This is a partial analysis");
  return <div className={`analysis-coverage-notice ${analysis.coverage}`} role="status"><WarningCircle weight="fill" /><span><strong>{title}</strong><small>{missing.length ? (pick(`${missing.join("、")}尚未完成，现有候选可以先比较，但不能当作完整规划。`, `${missing.join(", ")} is incomplete. You can compare the current options, but this is not a complete plan.`)) : pick("补充分析尚未完成，现有候选可以先比较。", "Additional analysis is incomplete; current options remain comparable.")}</small></span><button type="button" onClick={onRetry}>{pick("重新核验", "Recheck")}</button></div>;
}

function DomainAvailabilityNotice({ domainStatuses, onRetry }) {
  const { pick } = useUiLocale();
  if (!domainStatuses) return null;
  const labels = { play: pick("游玩", "activities"), food: pick("餐饮", "food"), stay: pick("住宿", "stays"), transport: pick("城际交通", "intercity transport") };
  const rows = Object.entries(domainStatuses).filter(([, value]) => value && !["completed_nonempty"].includes(value.status));
  if (!rows.length) return null;
  const statusText = (status) => ({
    empty_verified: pick("本次已查询来源在当前条件下没有返回可核验结果，不代表市场上没有。", "The checked sources returned no verified result for these conditions; this does not mean the market has none."),
    provider_unavailable: pick("资料来源当前不可用。", "The source is currently unavailable."),
    rate_limited: pick("资料来源当前限流。", "The source is currently rate-limited."),
    auth_required: pick("资料来源需要完成授权。", "The source requires authorization."),
    partial: pick("只有部分来源返回结果。", "Only some sources returned results."),
  }[status] ?? pick("资料状态仍待核验。", "Source status still needs verification."));
  return <div className="domain-availability-notice" role="status"><WarningCircle weight="fill" /><span>{rows.map(([domain, value]) => <small key={domain}><b>{labels[domain] ?? domain}</b>：{statusText(value.status)}</small>)}</span><button type="button" onClick={onRetry}>{pick("重试资料", "Retry sources")}</button></div>;
}

const PLANNING_FLOW = ["transport", "stay", "food", "play"];

function planningDomainCopy(domain, pick) {
  return {
    transport: { title: pick("抵达交通", "Getting there"), detail: pick("班次、到达点与落地接驳", "Schedule, arrival point and local transfer") },
    stay: { title: pick("住宿选择", "Stays"), detail: pick("决定每天往返距离和休息质量", "Sets daily travel distance and rest quality") },
    food: { title: pick("餐饮安排", "Food stops"), detail: pick("地方特色、排队与是否顺路", "Local character, waits and route fit") },
    play: { title: pick("游玩体验", "Experiences"), detail: pick("时间、体力、天气与绕行代价", "Time, effort, weather and detour cost") },
  }[domain];
}

function planningDomainPrompt(domain, locale = "zh-CN") {
  const english = locale === "en";
  return {
    transport: english ? "Compare suitable flights or trains for this trip, including schedule, arrival point and current fare snapshots." : "请重新比较适合这趟旅行的飞机或高铁，列出班次、到达点和本次查询票价。",
    stay: english ? "Find three stays that fit the route, budget and travelers, then explain the location tradeoff." : "请重新找 3 个符合动线、预算和同行人要求的住宿，并说明位置取舍。",
    play: english ? "Find three experiences that fit this trip and explain route cost, pace and weather fit." : "请重新找 3 个适合这趟旅行的游玩体验，并说明绕行、体力和天气影响。",
    food: english ? "Find three local places to eat that fit the route and explain local character, wait and budget." : "请重新找 3 个顺路的本地餐饮，并说明地方特色、排队和预算。",
  }[domain];
}

function choiceMeta(candidate, locale = "zh-CN") {
  const detail = candidate?.operability ?? {};
  const location = candidate?.location?.district || candidate?.location?.label || candidate?.location?.address || detail.arrivalPlace?.label || detail.departurePlace?.label || null;
  return [
    location,
    detail.rating ? `${locale === "en" ? "Rating" : "评分"} ${detail.rating}` : null,
    detail.roomName || detail.roomType || null,
  ].filter(Boolean).slice(0, 3);
}

function candidateReasonChips(candidate, pick) {
  const detail = candidate?.operability ?? {};
  const semanticReasons = (detail.semanticAnalysis?.reasons ?? []).filter((reason) => (reason.evidenceRefs?.length ?? 0) > 0).map((reason) => {
    const code = String(reason.reasonCode ?? "");
    if (/budget|price|fare|cost/i.test(code)) return pick("价格资料可比较", "Price evidence available");
    if (/inventory|offer|availability/i.test(code)) return detail.inventoryVerified === true ? pick("本次库存已核验", "Inventory checked for this search") : pick("库存仍需核验", "Inventory still needs checking");
    if (/local|long_tail|character|discovery/i.test(code)) return detail.longTailEvidence === "verified" ? pick("在地特色有独立证据", "Local character has independent evidence") : null;
    if (/route|walk|mobility|operability|schedule/i.test(code)) return pick("动线需结合试排核验", "Check route fit in a draft");
    if (/source|evidence|independ/i.test(code)) return pick("可查看来源依据", "Source evidence available");
    return null;
  }).filter(Boolean);
  const matchedAreas = detail.researchFit?.matchedTargetAreas ?? detail.researchMatch?.matchedTargetAreas ?? [];
  const sourceCount = new Set([...(candidate?.sourceRefs ?? []), ...(detail.providerSources ?? [])].filter(Boolean)).size;
  return [...new Set([
    ...semanticReasons,
    detail.inventoryVerified === true && detail.availableSeats !== 0 ? pick("本次库存已核验", "Inventory checked for this search") : null,
    matchedAreas.length && detail.stayAnchorFits?.length ? pick(`已核验到 ${matchedAreas.slice(0, 2).join("、")} 的实际动线`, `Route to ${matchedAreas.slice(0, 2).join(", ")} checked`) : null,
    detail.weatherFit === "preferred" ? pick("当前天气更适合", "Better fit for current weather") : null,
    sourceCount > 1 ? pick(`${sourceCount} 条来源线索`, `${sourceCount} source references`) : candidate?.sourceStatus === "verified_provider" ? pick("具名来源已核验", "Named source checked") : null,
  ].filter(Boolean))].slice(0, 3);
}

function BudgetBoard({ budget, previewDelta = null, compact = false }) {
  const { locale, pick } = useUiLocale();
  if (!budget) return null;
  const domainRows = [
    ["stay", pick("住", "Stay")], ["transport", pick("行", "Move")], ["food", pick("吃", "Eat")], ["play", pick("玩", "Explore")], ["other", pick("其他", "Other")],
  ];
  const projected = Number(budget.estimated ?? budget.committed ?? 0);
  const total = Number(budget.totalBudget ?? 0);
  const buckets = Object.values(budget.domains ?? {});
  const incompleteCount = buckets.filter((bucket) => bucket.quality === "unknown" || bucket.unknownCount > 0).length;
  const projectedPrefix = buckets.some((bucket) => bucket.quality === "estimate" || bucket.quality === "unknown") ? "~" : buckets.some((bucket) => bucket.quality === "reference") ? "≈" : "";
  const rawUsage = total > 0 ? Math.round((projected / total) * 100) : 0;
  const usage = Math.min(100, rawUsage);
  const currency = budget.currency === "CNY" ? "¥" : `${budget.currency} `;
  const amount = (value) => `${currency}${new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 0 }).format(Number(value ?? 0))}`;
  return <details className={`budget-board ${budget.exceedsBudget ? "over" : ""} ${compact ? "compact" : ""}`}><summary><span><CurrencyCircleDollar weight="duotone" /><span><strong>{pick("整趟预算", "Trip budget")} {projectedPrefix}{amount(projected)}{total > 0 ? ` / ${amount(total)}` : ""}</strong><small>{previewDelta?.estimated ? `${pick("本次试排", "This draft")} ${previewDelta.estimated > 0 ? "+" : "−"}${amount(Math.abs(previewDelta.estimated))}` : incompleteCount ? pick(`${incompleteCount} 个分域仍含待核验价格 · 展开看口径`, `${incompleteCount} areas still contain pending prices · open details`) : pick("展开看住、行、吃、玩的口径", "Open the stay, transport, food and activity breakdown")}</small></span></span><CaretDown /></summary><div className="budget-board-body"><div className="budget-domain-rows">{domainRows.map(([domain, label]) => { const bucket = budget.domains?.[domain]; if (!bucket) return null; const prefix = bucket.quality === "reference" ? "≈" : bucket.quality === "estimate" ? "~" : ""; const unknown = bucket.quality === "unknown" || bucket.unknownCount > 0 && !bucket.estimated; const note = [bucket.basis?.[0], bucket.unknownCount > 0 && bucket.estimated > 0 ? pick(`另有 ${bucket.unknownCount} 项待核验`, `${bucket.unknownCount} more pending`) : null].filter(Boolean).join(" · ") || (unknown ? pick("未取得可靠价格", "No reliable price") : ""); return <div key={domain}><strong>{label}</strong><span>{bucket.committed > 0 ? <em>{pick("已确认", "Confirmed")} {amount(bucket.committed)}</em> : null}<b className={bucket.quality}>{unknown ? pick("待核验", "Pending") : `${prefix}${amount(bucket.estimated || bucket.committed)}`}</b></span><small>{note}</small></div>; })}</div>{total > 0 ? <div className="budget-usage"><span><i style={{ width: `${usage}%` }} /></span><small>{budget.exceedsBudget ? pick(`预计超出预算 ${Math.max(0, rawUsage - 100)}%`, `Projected ${Math.max(0, rawUsage - 100)}% over budget`) : pick(`预计使用 ${rawUsage}%`, `${rawUsage}% projected`)}</small></div> : null}</div></details>;
}


function PlanningChoiceCard({ candidate, domain, confirmed = false, trial = false, baselineCandidate = null, partySize = 1, onChoose, onPreview, disabled = false }) {
  const { locale, pick } = useUiLocale();
  const details = choiceMeta(candidate, locale);
  const candidateCost = normalizedUiPrice(candidate).amount;
  const baselineCost = normalizedUiPrice(baselineCandidate).amount;
  const costDelta = candidateCost != null && baselineCost != null ? Math.round(candidateCost - baselineCost) : null;
  const photo = candidate.media?.find((item) => item.url);
  const [failedPhoto, setFailedPhoto] = useState(null);
  const reasons = candidateReasonChips(candidate, pick);
  return <article className={`atlas-place ${confirmed ? "is-confirmed" : ""} ${trial ? "is-selected" : ""}`}>
    {photo && failedPhoto !== photo.url ? <button type="button" className="atlas-place-photo" onClick={onPreview} aria-label={pick(`查看 ${candidate.title} 的详情`, `View ${candidate.title}`)}><img src={photo.url} alt={photo.title || candidate.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedPhoto(photo.url)} /><span>{pick("看地点", "Explore place")}<NavigationArrow /></span></button> : <div className="atlas-place-no-photo"><MapPin /><span>{pick(failedPhoto ? "地点图片暂未载入" : "暂无地点图片", failedPhoto ? "Place photo could not load" : "No place photo available")}</span></div>}
    <div className="atlas-place-body">
      <div className="atlas-place-status"><span>{confirmed ? pick("已加入行程", "In your trip") : trial ? pick("已加入试排 · 未确认", "In draft · not confirmed") : domainLabel(domain, locale)}</span>{confirmed || trial ? <CheckCircle weight="fill" /> : null}</div>
      <button type="button" className="atlas-place-title" onClick={onPreview}><h3>{candidate.title}</h3></button>
      <PriceSlot candidate={candidate} />
      {domain === "transport" && candidateCost != null && partySize > 1 ? <p className="atlas-place-fare">{pick(`${partySize} 人约 ¥${Math.round(candidateCost * partySize)}，不含接驳`, `About CNY ${Math.round(candidateCost * partySize)} for ${partySize}, transfers excluded`)}</p> : null}
      {domain === "transport" ? <TransportSnapshot detail={candidate.operability} compact /> : <p className="atlas-place-summary">{candidate.summary || pick("进一步了解地点与适合的旅行方式。", "Open the place to check the available details.")}</p>}
      {details.length ? <div className="atlas-place-facts">{details.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div> : null}
      {costDelta ? <p className="atlas-place-difference">{pick("比已选安排", "Compared with your selection")} {costDelta > 0 ? "+" : "−"}¥{Math.abs(costDelta)}</p> : null}
      <details className="atlas-evidence"><summary>{pick("资料依据与待核验项", "Sources & remaining checks")}<CaretDown /></summary><div>
        {reasons.map((reason) => <p key={reason}><Info />{reason}</p>)}
        {candidate.evidenceSummary?.headline ? <p>{candidate.evidenceSummary.headline}</p> : null}
        <p>{acceptedSourceLabel({ ...candidate, domain })}</p>
        {["food", "play"].includes(domain) && candidate.operability?.longTailEvidence === "not_verified_by_current_sources" ? <p>{pick("当地特色仍需独立资料或实际到访核验。", "Local character still needs independent evidence or a visit.")}</p> : null}
        <button type="button" onClick={onPreview}>{pick("查看完整详情", "Full place details")}<NavigationArrow /></button>
      </div></details>
      <footer className="atlas-place-actions"><button type="button" onClick={onPreview}>{pick("详情与记录", "Details & journal")}</button>{confirmed ? <span><CheckCircle />{pick("已确认", "Confirmed")}</span> : <button type="button" className={trial ? "atlas-remove" : "atlas-add"} aria-pressed={trial} disabled={disabled} onClick={onChoose}>{trial ? <X /> : <Plus />}{trial ? pick("移出试排", "Remove") : pick("加入试排", "Try in trip")}</button>}</footer>
    </div>
  </article>;
}

function routeTimeline(mobility, nodes, itinerary = mobility?.itinerary) {
  const legs = mobility?.legs ?? [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  if (itinerary?.stops?.length) {
    const legsByStop = new Map(legs.map((leg) => [leg.origin?.stopId ?? `${leg.origin?.nodeId}->${leg.destination?.nodeId}`, leg]));
    return itinerary.stops.map((stop) => {
      const outgoing = legsByStop.get(stop.stopId)
        ?? (!stop.stopId ? legs.find((leg) => leg.origin?.nodeId === stop.nodeId && leg.origin?.dayIndex === stop.dayIndex) : null)
        ?? null;
      const place = outgoing?.origin ?? legs.find((leg) => leg.destination?.stopId === stop.stopId)?.destination ?? { nodeId: stop.nodeId, stopId: stop.stopId, label: stop.title, dayIndex: stop.dayIndex, date: stop.date, role: stop.role, startAt: stop.startAt, endAt: stop.endAt };
      return { node: byId.get(stop.nodeId) ?? null, place, leg: outgoing, schedule: stop };
    });
  }
  if (!legs.length) return nodes.map((node) => ({ node, place: { nodeId: node.nodeId, label: node.title }, leg: null }));
  const rows = [{ node: byId.get(legs[0].origin?.nodeId) ?? null, place: legs[0].origin, leg: legs[0] }];
  legs.forEach((leg, index) => rows.push({ node: byId.get(leg.destination?.nodeId) ?? null, place: leg.destination, leg: legs[index + 1] ?? null }));
  return rows;
}

function routeTotals(mobility) {
  const recommended = (mobility?.legs ?? []).map((leg) => leg.alternatives?.find((alternative) => alternative.mode === leg.recommendedMode)).filter(Boolean);
  return {
    legCount: recommended.length,
    totalMinutes: recommended.reduce((sum, item) => sum + Number(item.totalMinutes ?? 0), 0),
    walkingMeters: recommended.reduce((sum, item) => sum + Number(item.walkingMeters ?? 0), 0),
    transfers: recommended.reduce((sum, item) => sum + Number(item.transfers ?? 0), 0),
    estimatedFareCny: recommended.reduce((sum, item) => sum + Number(item.estimatedFareCny ?? 0), 0),
  };
}

function mobilityWithModeOverrides(mobility, overrides) {
  if (!mobility || !Object.keys(overrides).length) return mobility;
  return { ...mobility, legs: (mobility.legs ?? []).map((leg) => ({ ...leg, recommendedMode: leg.alternatives?.some((alternative) => alternative.mode === overrides[leg.legId]) ? overrides[leg.legId] : leg.recommendedMode })) };
}

function itineraryStopLabel(stop, pick) {
  if (!stop) return pick("时间待补", "Time needed");
  const roles = {
    intercity_arrival: pick("抵达", "Arrival"), bag_drop: pick("寄存行李", "Bag drop"), stay_check_in: pick("入住", "Check-in"), stay_departure: pick("从住宿出发", "Leave stay"),
    stay_return: pick("返回住宿", "Return to stay"), meal: pick("用餐", "Meal"), activity: pick("游玩", "Activity"), local_transport: pick("市内移动", "Local transfer"),
  };
  const time = stop.startAt ? compactDateTime(stop.startAt) : stop.date;
  const day = Number.isInteger(stop.dayIndex) && stop.dayIndex > 0 ? pick(`第 ${stop.dayIndex} 天`, `Day ${stop.dayIndex}`) : null;
  return [day, time, roles[stop.role] ?? stop.role].filter(Boolean).join(" · ") || pick("时间待补", "Time needed");
}

function RouteWeatherDisclosure({ weather, onEdit }) {
  const { pick } = useUiLocale();
  if (!weather) return <button type="button" className="route-weather-summary pending" onClick={() => onEdit?.("我想补充具体旅行日期：", "旅行日期")}><CloudSun weight="duotone" /><span><strong>{pick("日期明确后核验天气", "Add dates to check weather")}</strong><small>{pick("天气会影响户外体验、移动缓冲和餐饮动线", "Weather affects outdoor plans, transfer buffers and food stops")}</small></span><NavigationArrow /></button>;
  const tripDates = new Set(weather.tripDates ?? []);
  const days = (weather.forecastDays ?? []).filter((day) => tripDates.has(day.date)).slice(0, 4);
  const conditions = [...new Set(days.flatMap((day) => [day.dayCondition, day.nightCondition]).filter(Boolean))];
  const temperatures = days.flatMap((day) => [day.lowC, day.highC]).filter(Number.isFinite);
  const temperatureLabel = temperatures.length ? `${Math.min(...temperatures)}–${Math.max(...temperatures)}°C` : null;
  const dateLabel = days.length ? `${days[0].date.slice(5).replace("-", "/")}–${days.at(-1).date.slice(5).replace("-", "/")}` : null;
  const active = weather.planningImpact?.active === true;
  const summary = active
    ? [weather.planningImpact.guidance?.play, weather.planningImpact.guidance?.transport].filter(Boolean).join(" ")
    : weather.coverage === "outside_forecast_window"
      ? pick("临近出发时再核验，不用当前天气替代未来预报。", "Check again closer to departure instead of using today's weather.")
      : pick("当前预报不需要改变路线。", "The current forecast does not require a route change.");
  return <details className={`route-weather-disclosure ${active ? "watch" : "clear"}`}><summary><CloudSun weight="duotone" /><span><strong>{active ? pick("天气会影响这版行程", "Weather affects this plan") : pick("天气与行程", "Weather and this trip")}</strong><small>{[dateLabel, conditions.join(" / "), temperatureLabel].filter(Boolean).join(" · ") || pick("预报范围待明确", "Forecast window pending")}</small></span><span>{pick("查看提醒", "View advice")}<CaretDown /></span></summary><div><p>{summary}</p><WeatherPlanningCard weather={weather} onEdit={onEdit} /></div></details>;
}

function RoutePreviewPanel({ trip, plan, nodes, mobility, comparisonNodes = [], comparisonMobility = null, preview, previewStatus, previewIsCurrent, routeModes = {}, onRouteModeChange, onFocusMap, onPreviewNode, onEditWeather, onOptimize, planningContext, onRetryRoute }) {
  const { locale, pick } = useUiLocale();
  const [focusNodeId, setFocusNodeId] = useState(null);
  const [activeLegId, setActiveLegId] = useState(null);
  const [activeDay, setActiveDay] = useState(undefined);
  useEffect(() => {
    if (focusNodeId && !nodes.some((node) => node.nodeId === focusNodeId)) setFocusNodeId(null);
  }, [nodes, focusNodeId]);
  const displayMobility = useMemo(() => mobilityWithModeOverrides(mobility, routeModes), [mobility, routeModes]);
  const activeItinerary = previewIsCurrent ? preview?.itinerary : displayMobility?.itinerary;
  const availableDays = useMemo(() => [...new Set((activeItinerary?.days ?? []).map((day) => Number(day.dayIndex)).filter((day) => Number.isInteger(day) && day > 0))].sort((left, right) => left - right), [activeItinerary]);
  useEffect(() => {
    if (!availableDays.length) {
      if (activeDay !== undefined) setActiveDay(undefined);
      return;
    }
    if (activeDay === undefined || (activeDay !== "all" && !availableDays.includes(activeDay))) setActiveDay(availableDays[0]);
  }, [availableDays.join(","), activeDay]);
  const allRows = routeTimeline(displayMobility, nodes, activeItinerary);
  const rows = activeDay === "all" || activeDay === undefined ? allRows : allRows.filter((row) => Number(row.schedule?.dayIndex ?? row.place?.dayIndex) === activeDay);
  const visibleLegIds = rows.map((row) => row.leg?.legId).filter(Boolean);
  useEffect(() => {
    if (activeLegId && visibleLegIds.includes(activeLegId)) return;
    setActiveLegId(visibleLegIds[0] ?? null);
  }, [activeDay, visibleLegIds.join(","), activeLegId]);
  const route = routeTotals(displayMobility);
  const routeMeasured = hasRouteMeasurements(displayMobility);
  const hasMapPoints = hasTripMapPoints(nodes, displayMobility);
  const baselineRoute = previewIsCurrent && routeMeasured ? preview?.impact?.baseline?.route ?? null : null;
  const delta = baselineRoute ? {
    totalMinutes: route.totalMinutes - baselineRoute.totalMinutes,
    walkingMeters: route.walkingMeters - baselineRoute.walkingMeters,
    transfers: route.transfers - baselineRoute.transfers,
    estimatedFareCny: route.estimatedFareCny - baselineRoute.estimatedFareCny,
  } : null;
  const unresolvedNodeIds = new Set(previewIsCurrent ? preview?.mobility?.coverage?.unresolvedNodeIds ?? [] : []);
  const unresolvedNodes = nodes.filter((node) => unresolvedNodeIds.has(node.nodeId));
  const activeBudget = previewIsCurrent ? preview?.impact?.budget ?? plan?.budget : plan?.budget;
  const budgetDelta = previewIsCurrent ? preview?.impact?.budgetDelta : null;
  const routeRecommendations = (displayMobility?.legs ?? []).map((leg) => leg.alternatives?.find((alternative) => alternative.mode === leg.recommendedMode)).filter(Boolean);
  const maxLegWalkingMeters = routeRecommendations.reduce((maximum, alternative) => Math.max(maximum, Number(alternative.walkingMeters ?? 0)), 0);
  const maxLegTransfers = routeRecommendations.reduce((maximum, alternative) => Math.max(maximum, Number(alternative.transfers ?? 0)), 0);
  const walkingTarget = mobility?.travelerFit?.planningWalkingTarget;
  const transferTarget = mobility?.travelerFit?.planningTransferTarget;
  const deltaParts = delta ? [
    delta.totalMinutes ? { label: `Δ ${delta.totalMinutes > 0 ? "+" : "−"}${Math.abs(Math.round(delta.totalMinutes))} ${pick("分钟", "min")}`, tone: delta.totalMinutes > 0 ? "up" : "down" } : null,
    delta.walkingMeters ? { label: `Δ ${delta.walkingMeters > 0 ? "+" : "−"}${Math.abs(Math.round(delta.walkingMeters))} m`, tone: delta.walkingMeters > 0 ? "up" : "down" } : null,
    delta.transfers ? { label: `Δ ${delta.transfers > 0 ? "+" : "−"}${Math.abs(delta.transfers)} ${pick("次换乘", "transfers")}`, tone: delta.transfers > 0 ? "up" : "down" } : null,
    delta.estimatedFareCny ? { label: `Δ ${delta.estimatedFareCny > 0 ? "+" : "−"}¥${Math.abs(Math.round(delta.estimatedFareCny))}`, tone: delta.estimatedFareCny > 0 ? "up" : "down" } : null,
    budgetDelta?.estimated ? { label: `${pick("整趟", "Trip")} Δ ${budgetDelta.estimated > 0 ? "+" : "−"}¥${Math.abs(Math.round(budgetDelta.estimated))}`, tone: budgetDelta.estimated > 0 ? "up" : "down" } : null,
  ].filter(Boolean) : [];
  const hasCurrentRouteComparison = (comparisonMobility?.legs?.length ?? 0) > 0;
  const isDraft = previewStatus !== "idle" || Boolean(preview);
  return <aside className={`route-preview-panel ${isDraft ? "trial-route" : "confirmed-route"}`} aria-label={isDraft ? pick("试选路线与影响", "Draft route and impact") : pick("已确认的完整行程", "Confirmed full itinerary")}>
    <header className="journey-route-heading"><div><span className="journey-eyebrow">{pick("02 · 看看怎么走", "02 · See how it connects")}</span><h2>{isDraft ? pick("这次试排的路线", "Your draft route") : pick("地点与路线", "Places and routes")}</h2></div><span className={isDraft ? "journey-draft-label" : "journey-route-label"}>{isDraft ? pick("尚未确认", "Not confirmed") : pick("以核验结果为准", "Evidence-based")}</span></header>
    <div className={`route-preview-map ${!hasMapPoints ? "without-points" : ""} ${previewStatus === "loading" ? "recalculating" : ""}`}>
      <TripDecisionMap nodes={nodes} comparisonNodes={comparisonNodes} activeNodeId={focusNodeId} activeLegId={activeLegId} activeDay={activeDay} onFocusNode={setFocusNodeId} onFocusLeg={setActiveLegId} mobility={displayMobility} comparisonMobility={previewIsCurrent ? comparisonMobility : null} tripId={trip?.tripId} staticMapAvailable={!preview && plan?.mapPreviewAvailable === true} label={pick("机场、住宿、游玩与餐饮的多点路线", "Multi-stop route across arrival, stay, activities and food")} locale={locale} />
      {availableDays.length ? <div className="route-day-switcher" role="tablist" aria-label={pick("选择地图日期", "Choose map day")}>
        {availableDays.map((day) => <button key={day} type="button" role="tab" aria-selected={activeDay === day} className={activeDay === day ? "active" : ""} onClick={() => setActiveDay(day)}>{pick(`第 ${day} 天`, `Day ${day}`)}</button>)}
        {availableDays.length > 1 ? <button type="button" role="tab" aria-selected={activeDay === "all"} className={activeDay === "all" ? "active" : ""} onClick={() => setActiveDay("all")}>{pick("全程", "All")}</button> : null}
      </div> : null}
      {isDraft ? <div className="route-comparison-legend"><strong>{hasCurrentRouteComparison ? pick("对比：当前 vs 试排", "Compare: current vs draft") : pick("首次试排", "First draft")}</strong><span><i className="trial" />{pick("试排路线", "Draft route")}</span>{hasCurrentRouteComparison ? <span><i className="current" />{pick("当前路线", "Current route")}</span> : null}</div> : null}
      {onFocusMap ? <button type="button" className="route-focus-button" onClick={onFocusMap}><MapTrifold />{pick("专注地图", "Focus map")}</button> : null}
      {previewStatus === "loading" ? <span className="route-recalculating"><CircleNotch className="spin" />{pick("正在重算多点路线…", "Recalculating the multi-stop route…")}</span> : null}
    </div>
    {isDraft ? <div className="route-trial-impact" aria-live="polite"><strong>{pick("试排影响", "Draft impact")}</strong>{previewStatus === "loading" ? <span>{pick("重算中…", "Recalculating…")}</span> : !routeMeasured ? <span>{pick("路线资料未齐，时间与费用待核验", "Route data incomplete; time and cost pending")}</span> : deltaParts.length ? deltaParts.map((part) => <span key={part.label} className={part.tone}>{part.label}</span>) : delta ? <span>{pick("耗时、步行、换乘和估算费用与当前行程一致", "Time, walking, transfers and estimated cost are unchanged")}</span> : previewIsCurrent && preview?.impact?.baseline?.kind === "none" ? <span>{pick(`首次试排：${Math.round(route.totalMinutes)} 分钟 · 约 ¥${Math.round(route.estimatedFareCny)}`, `First draft: ${Math.round(route.totalMinutes)} min · about CNY ${Math.round(route.estimatedFareCny)}`)}</span> : <span>{pick("等待路线核验", "Waiting for route check")}</span>}{walkingTarget != null || transferTarget != null ? <em className={(walkingTarget != null && maxLegWalkingMeters > walkingTarget) || (transferTarget != null && maxLegTransfers > transferTarget) ? "warning" : "ok"}>{pick("体力校验", "Effort")} {walkingTarget != null ? `${Math.round(maxLegWalkingMeters)}/${walkingTarget}m` : ""}{transferTarget != null ? ` · ${maxLegTransfers}/${transferTarget}` : ""}{(walkingTarget == null || maxLegWalkingMeters <= walkingTarget) && (transferTarget == null || maxLegTransfers <= transferTarget) ? <CheckCircle weight="bold" /> : null}</em> : null}</div> : null}
    {preview?.planningSource === "model_plan" && preview?.planSummary ? <div className="agent-trial-summary"><Sparkle weight="fill" /><span><strong>{!preview.feasibility?.canConfirm ? pick("草案已保留，以下事项仍需解决", "Draft saved; these issues remain") : pick("已核验这版草案，可查看后采用", "Checked draft, ready for review")}</strong><small>{preview.planSummary.objective}</small>{preview.planSummary.needsContext?.length ? <small>{pick("待补充：", "Still needed: ")}{preview.planSummary.needsContext.join("；")}</small> : null}<em>{(preview.planSummary.priorities ?? []).slice(0, 3).join(" · ")}</em></span></div> : null}
    {isDraft && preview?.planningSource === "conservative_fallback" ? <p className="route-planning-source"><Info weight="fill" />{pick("这是用于比较候选的快速连线，不代表 AI 已优化站序。", "This is a quick route for comparing options, not an AI-optimized stop order.")}</p> : null}
    {unresolvedNodes.length ? <div className="route-unresolved-warning"><WarningCircle weight="fill" /><span><strong>{pick("这次没有把所有试选地点接入路线", "Not every drafted place joined the route")}</strong><small>{unresolvedNodes.map((node) => node.title).join("、")}{pick(" 暂未成功定位；地图和时间合计不包含这些地点。", " could not be located, so the map and totals do not include them.")}</small></span><button type="button" onClick={onRetryRoute}><ArrowsClockwise />{pick("重算路线", "Retry route")}</button></div> : null}
    <details className="route-stop-disclosure"><summary><span>{route.legCount || Math.max(0, rows.length - 1)} {pick("段移动", "legs")} · {route.totalMinutes ? `${Math.round(route.totalMinutes)} ${pick("分钟", "min")}` : "—"} · {routeMeasured && Number.isFinite(route.walkingMeters) ? `${Math.round(route.walkingMeters)} m` : "—"} · {Number.isFinite(route.estimatedFareCny) && route.estimatedFareCny > 0 ? `¥${Math.round(route.estimatedFareCny)}` : "—"}</span><CaretDown /></summary><div className="route-stop-sheet"><BudgetBoard budget={activeBudget} previewDelta={budgetDelta} /><div className="route-context-grid">{walkingTarget != null || transferTarget != null ? <div className="route-traveler-fit within"><PersonSimpleWalk weight="duotone" /><span><strong>{pick("同行人体力校验", "Traveler effort")}</strong><small>{walkingTarget != null ? `${Math.round(maxLegWalkingMeters)}/${walkingTarget}m` : ""}{transferTarget != null ? ` · ${maxLegTransfers}/${transferTarget}` : ""}</small></span></div> : null}</div><section className="route-stop-timeline" aria-labelledby="route-stop-title"><header><span><strong id="route-stop-title">{pick("按时间看每一站", "Stops in time order")}</strong><small>{pick("建议时间可在确认前继续调整", "Suggested times can still be adjusted")}</small></span><button type="button" onClick={() => onOptimize?.(`${pick("请直接优化当前按天路线，比较先寄存行李、先入住或先游玩的取舍。保留固定抵达、预约和同行人限制，生成并核验一份可撤销试排：", "Optimize this day-by-day route now. Compare bag drop, check-in first, or sightseeing first; preserve fixed arrivals, reservations and traveler constraints, then return a checked reversible draft: ")} ${rows.map((row) => `${row.schedule?.date ?? ""} ${row.schedule?.startAt ?? "时间待核验"} ${row.schedule?.role ?? ""} ${row.node?.title ?? row.place?.label}`).join(" → ")}`, planningContext)}><Sparkle weight="fill" />{pick("AI 优化当前路线", "Optimize this route with AI")}</button></header><ol>{rows.map(({ node, place, leg, schedule }, index) => {
      const meta = domainMeta(node?.domain ?? "transport");
      const Icon = meta.icon;
      const recommended = leg?.alternatives?.find((alternative) => alternative.mode === leg.recommendedMode) ?? null;
      const alternatives = (leg?.alternatives ?? []).filter((alternative) => alternative.mode !== leg.recommendedMode).slice(0, 2);
      return <li key={schedule?.stopId ?? `${place?.nodeId ?? place?.label}-${index}`} className={node?.nodeId === focusNodeId || leg?.legId === activeLegId ? "active" : ""}>
        <div className="route-stop"><button type="button" className="route-stop-main" onClick={() => node?.nodeId && setFocusNodeId(node.nodeId)}><span>{index + 1}</span><Icon weight="duotone" /><span><small>{schedule ? itineraryStopLabel(schedule, pick) : node ? scheduleLabel(node) : pick("时间待补", "Time needed")}</small><strong>{schedule?.role === "intercity_arrival" ? place?.label : node?.title || place?.label || pick("地点待核验", "Place needs checking")}</strong></span></button>{node ? <button type="button" className="route-stop-detail" onClick={() => onPreviewNode(node.nodeId)} aria-label={pick(`查看${node.title}详情`, `Open details for ${node.title}`)}><NavigationArrow /></button> : null}</div>
        {leg ? <div className={`route-leg ${leg.legId === activeLegId ? "active" : ""}`}>
          <button type="button" className="route-leg-summary" aria-pressed={leg.legId === activeLegId} onClick={() => setActiveLegId(leg.legId)}>
            <strong>{place?.label ?? pick("当前地点", "Current place")} → {leg.destination?.label ?? pick("下一站", "Next stop")}</strong>
            <span>{MOBILITY_MODE_LABELS[leg.recommendedMode] || leg.recommendedMode} · {recommended ? `${recommended.totalMinutes} ${pick("分钟", "min")}` : pick("路线待核验", "Route needs checking")}</span>
            {recommended?.walkingMeters != null ? <small>{pick("步行", "Walk")} {Math.round(recommended.walkingMeters)} m{recommended.transfers != null ? ` · ${recommended.transfers} ${pick("次换乘", "transfers")}` : ""}{recommended.estimatedFareCny != null ? ` · ${pick("约", "about")} ¥${Math.round(recommended.estimatedFareCny)}` : ""}</small> : null}
          </button>
          <div className="route-mode-tabs" aria-label={pick("比较这段路的交通方式", "Compare modes for this leg")}>{leg.alternatives.map((alternative) => <button key={alternative.mode} type="button" className={alternative.mode === leg.recommendedMode ? "active" : ""} aria-pressed={alternative.mode === leg.recommendedMode} onClick={() => { setActiveLegId(leg.legId); onRouteModeChange?.(leg.legId, alternative.mode); }}>{MOBILITY_MODE_LABELS[alternative.mode] || alternative.mode}</button>)}</div>
          {alternatives.length ? <em>{alternatives.map((alternative) => `${MOBILITY_MODE_LABELS[alternative.mode] || alternative.mode} ${alternative.totalMinutes} min`).join(" / ")}</em> : null}
          {leg.legId === activeLegId && recommended?.steps?.length ? <details className="route-leg-steps"><summary>{pick("查看上车、换乘和步行", "View boarding, transfers and walking")}</summary><ol>{recommended.steps.map((step, stepIndex) => <li key={`${leg.legId}-${stepIndex}`}><strong>{step.line || MOBILITY_MODE_LABELS[step.kind] || pick("路段", "Step")}</strong><span>{step.instruction}</span>{step.durationMinutes != null || step.distanceMeters != null ? <small>{step.durationMinutes != null ? `${step.durationMinutes} ${pick("分钟", "min")}` : ""}{step.distanceMeters != null ? ` · ${Math.round(step.distanceMeters)} m` : ""}</small> : null}</li>)}</ol></details> : null}
        </div> : null}
      </li>;
    })}</ol></section><RouteWeatherDisclosure weather={plan?.weather} onEdit={onEditWeather} /></div></details>
    {previewStatus === "error" ? <div className="route-preview-error"><WarningCircle weight="fill" /><span>{pick("这次路线没有完成核验，当前继续显示上一版完整路线。", "The new route was not verified, so the previous complete route remains visible.")}</span><button type="button" onClick={onRetryRoute}><ArrowsClockwise />{pick("重新核验路线", "Retry route")}</button></div> : null}
    {previewStatus === "blocked" ? <div className="route-preview-error"><WarningCircle weight="fill" /><span>{preview?.feasibility?.primaryBlocker || pick("这份试排还不能形成可执行路线。", "This draft is not yet executable.")}</span><button type="button" onClick={onRetryRoute}><ArrowsClockwise />{pick("重新核验路线", "Retry route")}</button></div> : null}
  </aside>;
}

function useTripMobilityPreview({ trip, plan, proposal, acceptedItems, selections, agentTrial }) {
  const [candidatePreview, setCandidatePreview] = useState(null);
  const [modePreview, setModePreview] = useState(null);
  const [routeModes, setRouteModes] = useState({});
  const [previewSelectionKey, setPreviewSelectionKey] = useState("");
  const [previewStatus, setPreviewStatus] = useState("idle");
  const [previewNonce, setPreviewNonce] = useState(0);
  const requestSequence = useRef(0);
  const previewCache = useRef(new Map());
  const pendingNodeIds = useMemo(() => new Set(PLANNING_FLOW.flatMap((domain) => (proposal?.byDomain?.[domain] ?? []).map((node) => node.nodeId))), [proposal]);
  const uiSelections = useMemo(() => Object.fromEntries(Object.entries(selections).filter(([, nodeId]) => pendingNodeIds.has(nodeId))), [selections, pendingNodeIds]);
  const agentPreview = agentTrial?.itinerary && agentTrial.tripId === trip?.tripId && agentTrial.baseRevision === plan?.revision ? agentTrial : null;
  const activeSelections = agentPreview?.selections ?? uiSelections;
  const selectionKey = JSON.stringify(Object.entries(activeSelections).sort(([left], [right]) => left.localeCompare(right)));

  useEffect(() => {
    if (agentPreview) return undefined;
    if (!trip?.tripId || !Object.keys(activeSelections).length) {
      requestSequence.current += 1;
      setCandidatePreview(null);
      setPreviewSelectionKey("");
      setPreviewStatus("idle");
      return undefined;
    }
    const cacheKey = `${trip.tripId}:${plan?.revision}:${selectionKey}:${previewNonce}`;
    const cached = previewCache.current.get(cacheKey);
    if (cached) {
      setCandidatePreview(cached);
      setPreviewSelectionKey(selectionKey);
      setPreviewStatus(["completed", "partial"].includes(cached.status) ? "ready" : "blocked");
      return undefined;
    }
    const requestId = ++requestSequence.current;
    setPreviewStatus("loading");
    let controller = null;
    let requestTimeout = null;
    const timer = window.setTimeout(() => {
      controller = new AbortController();
      requestTimeout = window.setTimeout(() => controller.abort(), 90_000);
      api.previewMobility(trip.tripId, plan?.revision, activeSelections, controller.signal).then((result) => {
        if (requestId !== requestSequence.current) return;
        previewCache.current.set(cacheKey, result);
        setCandidatePreview(result);
        setPreviewSelectionKey(selectionKey);
        setPreviewStatus(["completed", "partial"].includes(result.status) ? "ready" : "blocked");
      }).catch(() => {
        if (requestId === requestSequence.current) setPreviewStatus("error");
      }).finally(() => window.clearTimeout(requestTimeout));
    }, 420);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(requestTimeout);
      controller?.abort();
    };
  }, [trip?.tripId, plan?.revision, selectionKey, previewNonce, agentPreview]);

  const basePreview = agentPreview ?? candidatePreview;
  useEffect(() => {
    setRouteModes({});
    setModePreview(null);
  }, [basePreview?.previewId]);
  useEffect(() => {
    if (!trip?.tripId || !basePreview?.previewId || !Object.keys(routeModes).length) {
      setModePreview(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.previewMobility(trip.tripId, plan?.revision, activeSelections, controller.signal, basePreview.previewId, routeModes)
        .then((result) => setModePreview(result))
        .catch(() => setModePreview(null));
    }, 160);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [trip?.tripId, plan?.revision, basePreview?.previewId, selectionKey, JSON.stringify(routeModes)]);

  const preview = modePreview ?? basePreview;
  const effectivePreviewStatus = agentPreview ? (preview?.feasibility?.canConfirm ? "ready" : "blocked") : previewStatus;

  const draftNodes = useMemo(() => {
    if (preview?.selectedNodes?.length) return preview.selectedNodes;
    const replacedDomains = new Set(Object.keys(activeSelections));
    const kept = acceptedItems.filter((node) => !replacedDomains.has(node.domain) || node.operability?.mobilityRole === "user_confirmed_arrival");
    const chosen = PLANNING_FLOW.flatMap((domain) => (proposal?.byDomain?.[domain] ?? []).filter((node) => activeSelections[domain] === node.nodeId).map((node) => ({ ...node, domain })));
    return [...new Map([...kept, ...chosen].map((node) => [node.nodeId, node])).values()].sort((left, right) => scheduleSortValue(left) - scheduleSortValue(right));
  }, [preview, acceptedItems, activeSelections, proposal]);
  const previewIsCurrent = Boolean(preview && (agentPreview || previewSelectionKey === selectionKey));
  const routeNodes = preview?.selectedNodes?.length ? preview.selectedNodes : effectivePreviewStatus === "error" && acceptedItems.length ? acceptedItems : draftNodes;
  const routeMobility = agentPreview || Object.keys(activeSelections).length ? preview?.mobility ?? plan?.mobility : plan?.mobility;
  const routeHasUnresolvedChoices = previewIsCurrent && (preview?.mobility?.coverage?.unresolvedNodeIds?.length ?? 0) > 0;
  const routeCanConfirm = previewIsCurrent && preview?.feasibility?.canConfirm === true;
  return {
    activeSelections,
    selectionKey,
    selectedCount: agentPreview ? new Set(routeNodes.map(node => node.nodeId)).size : Object.keys(activeSelections).length,
    preview,
    previewStatus: effectivePreviewStatus,
    previewIsCurrent,
    routeNodes,
    routeMobility,
    routeHasUnresolvedChoices,
    routeCanConfirm,
    routeBlocker: previewIsCurrent ? preview?.feasibility?.primaryBlocker ?? null : null,
    previewId: previewIsCurrent ? preview?.previewId ?? null : null,
    routeModes,
    setRouteMode: (legId, mode) => setRouteModes((current) => ({ ...current, [legId]: mode })),
    agentTrial: agentPreview,
    accept: agentPreview?.accept ?? null,
    retry: () => setPreviewNonce((current) => current + 1),
  };
}

function PlanningWorkbench({ trip, plan, proposal, acceptedItems, onSelectCandidate, previewModel, onPreviewCandidate, onAskAgent, onClearAgentTrial, onUpdateReadiness, onRequestLogin, onShowMap, loading, planningRequestActive, activeDomain, onDomainChange }) {
  const { locale, pick } = useUiLocale();
  const [showAll, setShowAll] = useState(false);
  const acceptedByDomain = useMemo(() => Object.fromEntries(PLANNING_FLOW.map((domain) => [domain, acceptedItems.filter((node) => node.domain === domain)])), [acceptedItems]);
  const { activeSelections, selectedCount, agentTrial } = previewModel;
  const confirmed = acceptedByDomain[activeDomain] ?? [];
  const candidates = proposal?.byDomain?.[activeDomain] ?? [];
  const options = showAll ? candidates : candidates.slice(0, 3);
  const selected = PLANNING_FLOW.flatMap((domain) => (proposal?.byDomain?.[domain] ?? []).filter((node) => activeSelections[domain] === node.nodeId).map((node) => ({ ...node, domain })));
  const copy = planningDomainCopy(activeDomain, pick);
  return <section className="atlas-discovery" aria-label={pick("挑选旅行地点", "Find places for your trip")}>
    {planningRequestActive ? <p className="atlas-live" role="status"><CircleNotch className="spin" />{pick("正在核验新的路线，你可以继续浏览当前安排。", "Checking a new route. You can keep browsing the current plan.")}</p> : null}
    <Tabs.Root className="atlas-domains" value={activeDomain} onValueChange={(domain) => { onDomainChange(domain); setShowAll(false); }}>
      <Tabs.List className="atlas-domain-nav" aria-label={pick("比较吃住行玩", "Compare parts of the trip")}>
        {PLANNING_FLOW.map((domain) => { const Icon = domainMeta(domain).icon; const count = proposal?.byDomain?.[domain]?.length ?? 0; const chosen = Boolean(activeSelections[domain] || acceptedByDomain[domain]?.length); return <Tabs.Tab key={domain} value={domain}><Icon /><span>{planningDomainCopy(domain, pick).title}</span>{chosen ? <CheckCircle weight="fill" aria-label={pick("已有选择", "Has a selection")} /> : <small>{count || "—"}</small>}</Tabs.Tab>; })}
      </Tabs.List>
      <Tabs.Panel value={activeDomain} className="atlas-domain-content">
        <div className="atlas-section-heading"><div><h2>{activeDomain === "stay" ? pick("住在哪里，决定怎么玩。", "A good stay shapes the whole trip.") : activeDomain === "play" ? pick("把想去的地方，放进旅程。", "Make room for the places you love.") : activeDomain === "food" ? pick("让一顿饭，也值得期待。", "Leave room for a memorable meal.") : pick("把路上的时间，安排得舒服。", "Make the journey feel easier.")}</h2><p>{copy.detail} · {pick("可以先试排，确认后才加入行程", "Try your options before confirming")}</p></div><button type="button" className="atlas-text-button" disabled={loading} onClick={() => onAskAgent(planningDomainPrompt(activeDomain, locale), copy.title)}><Sparkle />{pick("调整偏好", "Refine preferences")}</button></div>
        <div className="atlas-places">
          {confirmed.map((candidate) => <PlanningChoiceCard key={candidate.nodeId} candidate={{ ...candidate, domain: activeDomain }} domain={activeDomain} confirmed partySize={trip?.travelerCount || 1} onPreview={() => onPreviewCandidate(candidate.nodeId)} />)}
          {options.filter((candidate) => !confirmed.some((item) => item.nodeId === candidate.nodeId)).map((candidate) => <PlanningChoiceCard key={candidate.nodeId} candidate={{ ...candidate, domain: activeDomain }} domain={activeDomain} trial={activeSelections[activeDomain] === candidate.nodeId} baselineCandidate={confirmed[0]} partySize={trip?.travelerCount || 1} disabled={loading} onChoose={() => onSelectCandidate(activeDomain, nextTrialNodeId(activeSelections[activeDomain], candidate.nodeId))} onPreview={() => onPreviewCandidate(candidate.nodeId)} />)}
        </div>
        {!confirmed.length && !candidates.length ? <div className="atlas-empty"><h3>{pick("这部分还没有可靠候选", "No reliable options here yet")}</h3><p>{pick("换一个偏好，或稍后重新查找。已选的其他安排会保留。", "Refine your preferences or try again later. Your other choices stay in place.")}</p><button type="button" className="button primary" disabled={loading} onClick={() => onAskAgent(planningDomainPrompt(activeDomain, locale), copy.title)}>{pick("让助手继续查找", "Ask the assistant to research")}<NavigationArrow /></button></div> : null}
        {candidates.length > 3 ? <button className="atlas-more" type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? pick("收起更多候选", "Show fewer") : pick(`还有 ${candidates.length - 3} 个候选`, `${candidates.length - 3} more options`)}<CaretDown /></button> : null}
        <p className="atlas-source-note"><Info />{pick("价格与可用性以来源的最新核验为准，不代表已预订。", "Prices and availability need the latest source check. Nothing is booked.")}{proposal?.providerLabel ? ` · ${consumerProviderLabel(proposal.providerLabel)}` : ""}</p>
      </Tabs.Panel>
    </Tabs.Root>
    {selectedCount ? <aside className="atlas-draft-tray" aria-label={pick("待确认的试排", "Unconfirmed draft")}><div className="atlas-draft-label"><strong>{pick(`${selectedCount} 项试排`, `${selectedCount} in draft`)}</strong><small>{pick("还没改动行程", "Trip unchanged")}</small></div><div className="atlas-draft-items">{selected.map((node) => <button type="button" key={node.nodeId} disabled={loading} onClick={() => onSelectCandidate(node.domain, null)} aria-label={pick(`移出试排：${node.title}`, `Remove ${node.title} from draft`)}>{node.title}<X /></button>)}{agentTrial ? <span>{pick("助手优化的路线", "Assistant's route draft")}</span> : null}</div><button type="button" className="atlas-draft-clear" disabled={loading} onClick={() => { if (agentTrial) onClearAgentTrial?.(); else Object.keys(activeSelections).forEach((domain) => onSelectCandidate(domain, null)); }}>{pick("清空", "Clear")}</button><button type="button" className="button primary" onClick={onShowMap}>{pick("查看路线", "Review route")}<NavigationArrow /></button></aside> : null}
    <details className="atlas-trip-checks"><summary>{pick("旅行准备与资料状态", "Trip preparation & source status")}<CaretDown /></summary><div>
      <AnalysisCoverageNotice analysis={proposal?.analysis} onRetry={() => onAskAgent(pick("重新核验当前候选，并补充尚未完成的预算、当地体验或路线适配判断。", "Recheck the options and missing budget, local discovery and route fit."), pick("核验方案", "Check options"))} />
      <DomainAvailabilityNotice domainStatuses={proposal?.domainStatuses} onRetry={() => onAskAgent(pick("重新查找当前缺失的旅行资料。", "Research the missing travel information again."), pick("重试资料", "Retry sources"))} />
      <ReadinessStrip readiness={plan?.readiness} onUpdate={onUpdateReadiness} onAction={onAskAgent} onLogin={onRequestLogin} />
      <BudgetBoard budget={plan?.budget} compact />
    </div></details>
  </section>;
}


function TodayPanel({ trip, plan, nodes, onShowItinerary, onPrefill, onPreviewNode }) {
  const { locale, pick } = useUiLocale();
  const today = plan?.today;
  const currentNode = nodes.find((node) => node.nodeId === today?.currentTask?.nodeId) ?? nodes[0] ?? null;
  const nextNode = nodes.find((node) => node.nodeId === today?.nextTask?.nodeId) ?? null;
  const recommended = today?.route?.alternatives?.find((alternative) => alternative.mode === today.route.recommendedMode) ?? null;
  if (!today || today.status === "planning") return <section className="today-pane empty"><span className="eyebrow">Today</span><MapTrifold weight="duotone" /><h2>{pick("确认地点后，这里会变成行中首页", "This becomes your on-trip home after places are confirmed")}</h2><p>{pick("现在还没有已确认的路线。先在行程中比较并确认吃、住、行、玩，地图才会显示真实地点和下一步。", "There is no confirmed route yet. Compare and confirm the connected trip first, then the map can show real places and the next step.")}</p><button type="button" className="button primary" onClick={onShowItinerary}>{pick("返回行程选择", "Back to trip choices")}</button></section>;
  return <section className="today-pane" aria-labelledby="today-title">
    <header><div><span className="eyebrow">Today · {pick("现在与下一步", "Now and next")}</span><h2 id="today-title">{today.currentTask?.title || currentNode?.title || pick("当前安排待确认", "Current plan needs confirmation")}</h2><p>{today.status === "needs_schedule" ? pick("地点已经确认，但还没有可靠的每天时间；先看路线，再补时间。", "Places are confirmed, but daily timing is not reliable yet. Check the route first, then add timing.") : today.currentTask?.scheduledAt ? itineraryStopLabel({ ...today.currentTask, startAt: today.currentTask.scheduledAt }, pick) : scheduleLabel(currentNode)}</p></div><button type="button" className="quiet-button" onClick={onShowItinerary}><List />{pick("完整行程", "Full trip")}</button></header>
    <div className="today-map"><TripDecisionMap nodes={nodes} activeNodeId={currentNode?.nodeId} onFocusNode={onPreviewNode} mobility={plan?.mobility} tripId={trip?.tripId} staticMapAvailable={plan?.mapPreviewAvailable === true} label={pick("今日地点和路线地图", "Today's places and routes map")} locale={locale} /></div>
    <article className="today-current-card">{currentNode?.media?.[0] ? <img src={currentNode.media[0].url} alt={currentNode.media[0].title || `${currentNode.title} ${pick("实景图", "photo")}`} /> : null}<div><small>{pick("现在", "Now")}</small><strong>{currentNode?.title}</strong><p>{currentNode?.location?.address || currentNode?.location?.label || currentNode?.operability?.arrivalRouteAnchor?.label || currentNode?.operability?.arrivalPlace?.label || pick("位置资料待核验", "Location still needs checking")}</p>{recommended ? <span>{MOBILITY_MODE_LABELS[today.route.recommendedMode] || today.route.recommendedMode}，{locale === "en" ? `about ${recommended.totalMinutes} min` : `约 ${recommended.totalMinutes} 分钟`}{recommended.walkingMeters != null ? (locale === "en" ? `, ${Math.round(recommended.walkingMeters)} m walking` : `，步行 ${Math.round(recommended.walkingMeters)} 米`) : ""}</span> : <span>{pick("城市路线仍待核验", "City route still needs checking")}</span>}{currentNode ? <button type="button" className="today-place-open" onClick={() => onPreviewNode(currentNode.nodeId)}>{pick("查看地点与记录", "Details & memories")}<CaretDown /></button> : null}</div></article>
    {today.nextTask ? <button type="button" className="today-next-card" disabled={!nextNode} onClick={() => { if (nextNode) onPreviewNode(nextNode.nodeId); }}><span><Clock /></span><div><small>{pick("下一步", "Next")}</small><strong>{today.nextTask.title || nextNode?.title}</strong><p>{today.nextTask.scheduledAt ? itineraryStopLabel({ ...today.nextTask, startAt: today.nextTask.scheduledAt }, pick) : scheduleLabel(nextNode)}</p></div><NavigationArrow /></button> : null}
    {today.attentionItems?.length ? <section className="today-attention"><strong>{pick("出发前再看一眼", "Check before leaving")}</strong>{today.attentionItems.map((rawItem) => { const item = localizedReadinessItem(rawItem, locale); return <span key={item.itemId}><WarningCircle weight="fill" />{item.title}: {(locale === "en" ? READINESS_STATUS_LABELS_EN : READINESS_STATUS_LABELS)[item.status]}</span>; })}</section> : null}
    <section className="today-change"><div><strong>{pick("事情有变化？", "Something changed?")}</strong><small>{pick("只调整受影响部分，不重做整趟旅行。", "Only update the affected part, not the whole trip.")}</small></div><div>{(locale === "en" ? [["Flight or train delayed", "Transport delay"], ["It started raining", "Rain"], ["A traveler's energy changed", "Energy change"], ["A place closed unexpectedly", "Place closed"]] : [["航班或火车延误", "航班或火车延误"], ["开始下雨", "开始下雨"], ["同行人体力变化", "同行人体力变化"], ["地点临时关闭", "地点临时关闭"]]).map(([label, context]) => <button key={label} type="button" onClick={() => onPrefill(locale === "en" ? `Something changed: ${label}. Keep confirmed plans that are not affected, give me one reliable alternative, and explain the impact.` : `事情有变化：${label}。请保留不受影响的已确认安排，只给我一个可靠替代并说明影响。`, context)}>{label}</button>)}</div></section>
    <p className="today-freshness">{pick("路线为查询时估算，不是实时到站或即时车费；电梯、卫生间等设施资料需现场确认。", "Routes are query-time estimates, not live arrivals or final fares. Elevators, toilets and other facilities must be confirmed on site.")}</p>
  </section>;
}


function PlanningWorkspaceSkeleton() {
  const { pick } = useUiLocale();
  return <section className="workspace-planning-state" role="status" aria-live="polite">
    <header><span><MapTrifold weight="duotone" /></span><div><h2>{pick("正在把需求整理成一趟旅行", "Turning your request into a trip")}</h2><p>{pick("先理解同行人和预算，再核验地点、路线与可执行信息。", "Understanding travelers and budget, then checking places, routes and execution details.")}</p></div></header>
    <div className="planning-skeleton-layout" aria-hidden="true"><div className="planning-skeleton-map"><i /><i /><i /><i className="route" /></div><div className="planning-skeleton-list">{[0, 1, 2].map((item) => <span key={item}><b /><em><i /><i /></em></span>)}</div></div>
    <footer>{pick("真实资料返回后，地图和可比较候选会直接出现在这里。", "The map and comparable options will appear here when verified sources return.")}</footer>
  </section>;
}

function TripWorkspaceEmpty({ hasMessages = false }) {
  const { pick } = useUiLocale();
  return <section className="workspace-zero-state workbench-zero-state"><div className="workspace-zero-copy"><MapTrifold weight="duotone" /><h2>{hasMessages ? pick("需求已经保留，可以继续补充", "Your request is saved. Continue when ready.") : pick("地图和行程会在这里出现", "Your map and trip will appear here")}</h2><p>{hasMessages ? pick("资料恢复或信息补齐后，旅行助手会从当前对话继续，不用重新填写。", "When sources recover or details are complete, the Agent continues from this conversation.") : pick("旅行助手理解需求后，会把地点、路线、准备事项和待确认选择放在同一个工作区。", "Once the Agent understands your request, places, routes, preparation and choices stay in one workspace.")}</p><ul><li><MapPin weight="duotone" /><span><strong>{pick("先看空间关系", "See the spatial picture")}</strong><small>{pick("住宿锚点、到达方式和地点分布", "Stay anchor, arrival and place distribution")}</small></span></li><li><Compass weight="duotone" /><span><strong>{pick("只比较关键取舍", "Compare meaningful tradeoffs")}</strong><small>{pick("时间、预算、步行和同行人适配", "Time, budget, walking and traveler fit")}</small></span></li><li><CheckCircle weight="duotone" /><span><strong>{pick("确认后才加入旅行", "Confirm before anything changes")}</strong><small>{pick("缺失资料和风险始终明确显示", "Missing evidence and risks stay visible")}</small></span></li></ul></div><div className="workbench-zero-skeleton" aria-hidden="true"><div className="zero-map-grid"><i /><i /><i /><span /></div><div className="zero-decision-lines">{PLANNING_FLOW.map((domain) => { const Icon = domainMeta(domain).icon; return <span key={domain}><Icon weight="duotone" /><i /><i /></span>; })}</div></div></section>;
}

function PlanCanvas({ conversation, trip, plan, agentTrial, planningRequestActive, tripRecovery, dataUnavailable, onRefresh, onRetryResearch, onRecoverTrip, onAcceptProposal, onRejectProposal, onSubmitFeedback, onUpdateReadiness, onRequestLogin, onPrefill, onPlanPhoto, onRunPlanning, onClearAgentTrial, onFocusMap, onTrialStateChange, activeMobileView, onMobileViewChange, loading }) {
  const { locale, pick } = useUiLocale();
  const items = useMemo(() => Object.entries(plan?.byDomain ?? {})
    .flatMap(([domain, nodes]) => nodes.filter((node) => node.selected).map((node) => ({ ...node, domain })))
    .sort((left, right) => scheduleSortValue(left) - scheduleSortValue(right) || DOMAIN_ITEMS.findIndex((item) => item.key === left.domain) - DOMAIN_ITEMS.findIndex((item) => item.key === right.domain)), [plan]);
  const proposal = plan?.pendingProposals?.[0] ?? null;
  const proposalCandidates = useMemo(() => proposal ? DOMAIN_ITEMS.flatMap(({ key }) => (proposal.byDomain?.[key] ?? []).map((node) => ({ ...node, domain: key }))) : [], [proposal]);
  const workspaceNodes = useMemo(() => [...new Map([...items, ...proposalCandidates].map((node) => [node.nodeId, node])).values()], [items, proposalCandidates]);
  const [selections, setSelections] = useState({});
  const [activeDomain, setActiveDomain] = useState(() => PLANNING_FLOW.find((domain) => proposal?.byDomain?.[domain]?.length) ?? "stay");
  const [detailNodeId, setDetailNodeId] = useState(null);
  const [showConfirmedRoute, setShowConfirmedRoute] = useState(false);
  useEffect(() => setShowConfirmedRoute(false), [trip?.tripId]);
  const detailSnapshot = useRef(null);
  const proposalSelectionFingerprint = proposal ? `${proposal.proposalId}:${proposal.baseRevision}:${proposalCandidates.map((node) => node.nodeId).join(",")}` : "";
  const acceptedSelectionFingerprint = items.map((node) => `${node.domain}:${node.nodeId}`).join(",");
  useEffect(() => setSelections({}), [proposalSelectionFingerprint, acceptedSelectionFingerprint]);
  const previewModel = useTripMobilityPreview({ trip, plan, proposal, acceptedItems: items, selections, agentTrial });
  useEffect(() => onTrialStateChange?.({ active: previewModel.selectedCount > 0, count: previewModel.selectedCount, status: previewModel.previewStatus }), [previewModel.selectedCount, previewModel.previewStatus, onTrialStateChange]);
  const selectCandidate = (domain, nodeId) => {
    if (loading) return;
    if (agentTrial) onClearAgentTrial?.();
    setSelections((current) => {
      const next = { ...current };
      if (nodeId) next[domain] = nodeId;
      else delete next[domain];
      return next;
    });
  };
  const liveDetailNode = workspaceNodes.find((node) => node.nodeId === detailNodeId) ?? null;
  useEffect(() => {
    if (liveDetailNode) detailSnapshot.current = { tripId: trip?.tripId, node: liveDetailNode };
  }, [liveDetailNode, trip?.tripId]);
  const baseDetailNode = liveDetailNode ?? (detailSnapshot.current?.tripId === trip?.tripId && detailSnapshot.current?.node.nodeId === detailNodeId ? detailSnapshot.current.node : null);
  const previewDetailNode = previewModel.preview?.selectedNodes?.find((node) => node.nodeId === detailNodeId) ?? null;
  const detailNode = baseDetailNode && previewDetailNode ? { ...baseDetailNode, ...previewDetailNode, operability: { ...(baseDetailNode.operability ?? {}), ...(previewDetailNode.operability ?? {}) } } : baseDetailNode;
  const view = activeMobileView === "map" ? "map" : activeMobileView === "journal" ? "journal" : "itinerary";
  const changeView = (value) => onMobileViewChange(value);
  const viewBodyRef = useRef(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (view !== previousView.current) {
      viewBodyRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
      viewBodyRef.current?.focus({ preventScroll: true });
      previousView.current = view;
    }
  }, [view]);
  const confirmDraft = () => {
    const target = previewModel.agentTrial ? previewModel.accept : proposal?.proposalId ? { proposalId: proposal.proposalId, selections: previewModel.activeSelections, partial: true, previewId: previewModel.previewId, baseRevision: plan?.revision } : null;
    if (target && previewModel.routeCanConfirm && !loading) onAcceptProposal(target.proposalId, target.selections, { partial: target.partial, previewId: previewModel.previewId, baseRevision: target.baseRevision, routeModes: previewModel.routeModes });
  };
  return <section className="atlas-canvas" id="trip-plan-canvas">
    {trip ? <>
      <header className="atlas-trip-heading"><div className="atlas-trip-identity"><p>{pick("我的下一段旅程", "YOUR NEXT JOURNEY")}</p><h1>{trip.destination || pick("我的旅行", "My trip")}<span>{trip.durationDays ? pick(`${trip.durationDays} 日`, `${trip.durationDays} days`) : pick("旅行计划", "Travel plan")}</span></h1>
        <div className="atlas-trip-facts"><button type="button" onClick={() => onPrefill(pick("这趟旅行的出发与返回日期是：", "The start and end dates of this trip are: "), pick("旅行日期", "Trip dates"))}><CalendarBlank />{compactTripDates(trip.dates, trip.durationDays, locale)}<CaretDown /></button><button type="button" onClick={() => onPrefill(pick("同行人和出行要求是：", "The travelers and their needs are: "), pick("同行人", "Travelers"))}><User />{trip.travelerCount ? pick(`${trip.travelerCount} 人同行`, `${trip.travelerCount} travelers`) : pick("人数待补", "Add travelers")}<CaretDown /></button><button type="button" onClick={() => onPrefill(pick("这趟旅行的总预算是：", "The total budget for this trip is: "), pick("预算", "Budget"))}><CurrencyCircleDollar />{trip.totalBudget != null ? `¥${Number(trip.totalBudget).toLocaleString(locale === "en" ? "en-US" : "zh-CN")}` : pick("设置预算", "Set budget")}<CaretDown /></button></div>
      </div><div className="atlas-trip-progress"><strong>{items.length ? pick(`${items.length} 个安排已确认`, `${items.length} confirmed places`) : pick("好旅行，从一个好选择开始。", "A good trip begins with a good choice.")}</strong><p>{pick("先挑喜欢的，再看怎么串起来。", "Find your places. Then find your way.")}</p><button type="button" onClick={() => changeView(view === "itinerary" ? "map" : "itinerary")}>{view === "itinerary" ? pick("打开行程路线", "Open trip route") : pick("继续挑选地点", "Keep exploring")}<NavigationArrow /></button></div></header>
      <nav className="atlas-view-nav" aria-label={pick("旅行视图", "Trip views")}>{[{ key: "itinerary", label: pick("发现与比较", "Explore & compare"), Icon: Compass }, { key: "map", label: pick("行程与路线", "Trip & route"), Icon: MapTrifold }, { key: "journal", label: pick("旅行手账", "Travel journal"), Icon: ImageSquare }].map(({ key, label, Icon }) => <button type="button" key={key} aria-current={view === key ? "page" : undefined} onClick={() => changeView(key)}><Icon />{label}{key === "map" && previewModel.selectedCount ? <span>{previewModel.selectedCount}</span> : null}</button>)}</nav>
    </> : null}
    <div className="atlas-view-body" ref={viewBodyRef} tabIndex={-1}>
    {!trip ? tripRecovery ? <div className="atlas-empty"><h2>{pick("旅行要求还在，草案需要恢复", "Your requirements are safe. Restore the draft.")}</h2><p>{pick("沿用这段对话里的目的地、同行人和偏好，不必重新填写。", "Reuse the destination, travelers and preferences already in this conversation.")}</p><button type="button" className="button primary" disabled={loading} onClick={onRecoverTrip}><ArrowsClockwise />{pick("恢复并继续规划", "Restore and continue")}</button></div> : loading ? <PlanningWorkspaceSkeleton /> : <TripWorkspaceEmpty hasMessages={Boolean(conversation?.messages?.length)} /> :
      view === "journal" ? <section className="atlas-journal-view"><Suspense fallback={<p role="status">{pick("正在打开旅行手账…", "Opening your journal…")}</p>}><LazyTravelPhotoJournal key={trip.tripId} tripId={trip.tripId} locale={locale} onPlanPhoto={onPlanPhoto} /></Suspense>{workspaceNodes.length ? <section className="atlas-journal-places"><h3>{pick("从一个地点，开始记录", "Start with a place")}</h3><p>{pick("收藏出发前的灵感，或留下途中拍到的建筑与食物。", "Keep an idea for later, or a building or dish you photographed along the way.")}</p><div>{workspaceNodes.map((node) => <button type="button" key={node.nodeId} onClick={() => setDetailNodeId(node.nodeId)}>{node.media?.[0]?.url ? <img src={node.media[0].url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <MapPin />}<span>{node.title}<small>{node.selected ? pick("已加入行程", "In your trip") : pick("候选地点 · 也可以记录", "An option · you can still keep a memory")}</small></span><NavigationArrow /></button>)}</div></section> : null}</section> :
      view === "map" ? <section className="atlas-route-view">
        <div className="atlas-section-heading"><div><h2>{previewModel.selectedCount ? pick("这些地方，能顺路吗？", "How do these places fit together?") : pick("你的行程，放到路上看。", "Your trip, on the road.")}</h2><p>{previewModel.selectedCount ? pick("这是试排。核对时间、步行和预算后，再确认加入。", "This is a draft. Check time, walking and budget before confirming.") : pick("这里只显示已经确认的安排。", "Only confirmed choices appear here.")}</p></div><button type="button" className="atlas-text-button" onClick={() => changeView("itinerary")}>{pick("继续挑选", "Keep exploring")}<Plus /></button></div>
        {previewModel.selectedCount ? <>
          {previewModel.routeBlocker ? <div className="atlas-route-blocker" role="status"><WarningCircle /><div><strong>{pick("确认前，还需要补齐", "One thing to resolve before confirming")}</strong><p>{previewModel.routeBlocker}</p></div><button type="button" onClick={() => onPrefill(pick("请帮我解决这份试排行程的核验问题：", "Help resolve the checks for this draft: ") + previewModel.routeBlocker, pick("完善试排", "Complete the draft"))}>{pick("让助手继续处理", "Continue with the assistant")}</button></div> : null}
          <RoutePreviewPanel trip={trip} plan={plan} nodes={previewModel.routeNodes} comparisonNodes={items} mobility={previewModel.routeMobility} comparisonMobility={plan?.mobility} preview={previewModel.preview} previewStatus={previewModel.previewStatus} previewIsCurrent={previewModel.previewIsCurrent} routeModes={previewModel.routeModes} onRouteModeChange={previewModel.setRouteMode} onPreviewNode={setDetailNodeId} onEditWeather={onPrefill} onOptimize={onRunPlanning} planningContext={{ proposalId: previewModel.agentTrial?.proposalId ?? proposal?.proposalId ?? null, previewId: previewModel.previewId, selections: previewModel.activeSelections, routeModes: previewModel.routeModes, currentOrder: (previewModel.preview?.itinerary?.stops ?? []).map((stop) => stop.nodeId) }} onRetryRoute={previewModel.retry} />
          <footer className="atlas-route-confirm"><div><strong>{pick(`${previewModel.selectedCount} 项待确认`, `${previewModel.selectedCount} choices to confirm`)}</strong><small>{pick("不产生预订或付款", "No bookings or payments")}</small></div><button type="button" className="atlas-text-button" disabled={loading} onClick={() => { if (agentTrial) onClearAgentTrial?.(); else setSelections({}); changeView("itinerary"); }}>{pick("放弃试排", "Discard draft")}</button><button type="button" className="button primary" disabled={loading || previewModel.previewStatus !== "ready" || previewModel.routeHasUnresolvedChoices || !previewModel.routeCanConfirm} onClick={confirmDraft}>{loading || previewModel.previewStatus === "loading" ? <CircleNotch className="spin" /> : <CheckCircle />}{pick("确认加入行程", "Confirm into trip")}</button></footer>
        </> : items.length ? showConfirmedRoute ? <>
          <button type="button" className="quiet-button" onClick={() => setShowConfirmedRoute(false)}>{pick("返回现在与下一步", "Back to now and next")}</button>
          <RoutePreviewPanel trip={trip} plan={plan} nodes={items} mobility={plan?.mobility} previewStatus="idle" previewIsCurrent={false} onPreviewNode={setDetailNodeId} onEditWeather={onPrefill} onOptimize={onRunPlanning} planningContext={{ currentOrder: (plan?.mobility?.itinerary?.stops ?? []).map(stop => stop.nodeId) }} />
        </> : <TodayPanel trip={trip} plan={plan} nodes={items} onShowItinerary={() => setShowConfirmedRoute(true)} onPrefill={onPrefill} onPreviewNode={setDetailNodeId} /> : <div className="atlas-empty"><h3>{pick("先选几个想去的地方", "Choose a few places first")}</h3><p>{pick("把候选加入试排，就能在这里核对路线与时间。", "Add options to a draft, then check their routes and timing here.")}</p><button type="button" className="button primary" onClick={() => changeView("itinerary")}>{pick("去挑选地点", "Explore places")}<NavigationArrow /></button></div>}
      </section> :
      proposal || items.length ? <PlanningWorkbench activeDomain={activeDomain} onDomainChange={setActiveDomain} trip={trip} plan={plan} proposal={proposal} acceptedItems={items} onSelectCandidate={selectCandidate} previewModel={previewModel} onPreviewCandidate={setDetailNodeId} onAskAgent={onPrefill} onClearAgentTrial={onClearAgentTrial} onUpdateReadiness={onUpdateReadiness} onRequestLogin={onRequestLogin} onShowMap={() => changeView("map")} loading={loading} planningRequestActive={planningRequestActive} /> :
      <div className="atlas-empty"><h2>{dataUnavailable ? pick("地点资料暂时未能加载", "Place sources are temporarily unavailable") : pick("把这趟旅行再说具体一点", "A little more about your trip")}</h2><p>{pick("旅行要求已经保留。补充关键偏好后，继续查找适合你的地点。", "Your requirements are saved. Add the important details and continue finding places.")}</p><button type="button" className="button primary" disabled={loading} onClick={dataUnavailable ? onRetryResearch : () => onPrefill(pick("继续完善我的旅行计划：", "Continue planning my trip: "), pick("旅行要求", "Trip needs"))}>{pick("继续规划", "Continue planning")}<NavigationArrow /></button></div>}
    </div>
    <PlaceDetailSheet node={detailNode} plan={plan} tripId={trip?.tripId} unavailable={Boolean(detailNode && !liveDetailNode)} onClose={() => setDetailNodeId(null)} onPlanPhoto={async (photo) => { if (await onPlanPhoto(photo) !== false) setDetailNodeId(null); }} onSubmitFeedback={(input) => onSubmitFeedback(detailNode, input)} onTrialCandidate={liveDetailNode ? () => { if (!liveDetailNode || liveDetailNode.selected) return; selectCandidate(detailNode.domain, detailNode.nodeId); setDetailNodeId(null); } : undefined} />
    {conversation?.messages?.some((message) => message.role === "status" && message.kind?.includes("model")) ? <div className="canvas-warning workspace-warning"><WarningCircle /><p>{pick("旅行助手暂时无法回应，需求会保留。", "The assistant is unavailable. Your request is kept.")}</p></div> : null}
  </section>;
}

function ConversationPicker({ conversations, deletedConversations = [], activeId, unavailableTripIds, onPick, onNew, onDelete, onRestore, managementStatus = {}, onDismissStatus }) {
  const { locale, pick } = useUiLocale();
  const [showDeleted, setShowDeleted] = useState(false);
  const renderConversationList = (items, deleted) => <div className="conversation-list">{items.length ? items.map((conversation) => {
    const needsRecovery = conversation.tripId && unavailableTripIds?.has(conversation.tripId);
    const title = conversation.messages.find((message) => message.role === "user")?.text || pick("新的旅行想法", "New trip idea");
    return deleted ? <div key={conversation.conversationId} className="conversation-list-row deleted"><div className="conversation-row-copy"><strong>{title}</strong><span className="conversation-meta"><small>{pick("会话已删除，关联行程仍保留", "Conversation deleted; linked trip preserved")}</small><time>{formatConversationRecency(conversation.deletedAt || conversation.updatedAt, locale)}</time></span></div><button type="button" className="conversation-restore" onClick={() => onRestore(conversation)}><ArrowCounterClockwise />{pick("恢复", "Restore")}</button></div> : <div key={conversation.conversationId} className={`conversation-list-row ${conversation.conversationId === activeId ? "active" : ""}`}><button type="button" className="conversation-select" onClick={() => onPick(conversation.conversationId)}><strong>{title}</strong><span className="conversation-meta"><small className={needsRecovery ? "needs-recovery" : ""}>{needsRecovery ? pick("草案需恢复", "Draft needs recovery") : conversation.tripId ? pick("已建立旅行草案", "Trip draft created") : pick("等待旅行需求", "Waiting for a request")}</small><time>{formatConversationRecency(conversation.updatedAt, locale)}</time></span></button><button type="button" className="conversation-delete" onClick={() => onDelete(conversation)} aria-label={locale === "en" ? `Delete conversation: ${title}` : `删除会话：${title}`}><Trash /></button></div>;
  }) : <p className="conversation-empty">{deleted ? pick("最近删除中没有会话。", "No recently deleted conversations.") : pick("还没有对话。", "No conversations yet.")}</p>}</div>;
  return <aside className="conversation-picker">
    <div className="conversation-picker-heading"><h2>{pick("旅行与对话", "Trips and conversations")}</h2><small>{pick("继续规划、管理或恢复会话", "Continue, manage or restore conversations")}</small></div>
    {managementStatus.notice || managementStatus.error ? <div className={`conversation-management-notice ${managementStatus.error ? "error" : ""}`} role={managementStatus.error ? "alert" : "status"}>{managementStatus.error || managementStatus.notice}<button type="button" onClick={onDismissStatus}><X /></button></div> : null}
    <Tabs.Root className="conversation-filter-root" value={showDeleted ? "deleted" : "active"} onValueChange={(value) => setShowDeleted(value === "deleted")}>
      <Tabs.List className="conversation-filter-tabs" aria-label={pick("筛选旅行会话", "Filter trip conversations")}>
        <Tabs.Tab value="active" className={!showDeleted ? "active" : ""}>{pick("进行中", "Active")}<span>{conversations.length}</span></Tabs.Tab>
        <Tabs.Tab value="deleted" className={showDeleted ? "active" : ""}>{pick("最近删除", "Recently deleted")}<span>{deletedConversations.length}</span></Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="active" className="conversation-filter-panel"><button className="new-chat" onClick={onNew}><Plus />{pick("新对话", "New conversation")}</button>{renderConversationList(conversations, false)}</Tabs.Panel>
      <Tabs.Panel value="deleted" className="conversation-filter-panel">{renderConversationList(deletedConversations, true)}</Tabs.Panel>
    </Tabs.Root>
  </aside>;
}

function TravelEditor({ session, onAccount, onRequestLogin }) {
  const { locale, setLocale, pick } = useUiLocale();
  const [conversations, setConversations] = useState([]);
  const [deletedConversations, setDeletedConversations] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [conversationToDelete, setConversationToDelete] = useState(null);
  const [conversationManagementStatus, setConversationManagementStatus] = useState({});
  const [draft, setDraft] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [failedDraft, setFailedDraft] = useState(null);
  const [pendingSync, setPendingSync] = useState(null);
  const [trip, setTrip] = useState(null);
  const [plan, setPlan] = useState(null);
  const [tripRecovery, setTripRecovery] = useState(null);
  const [unavailableTripIds, setUnavailableTripIds] = useState(() => new Set());
  const [providerStatus, setProviderStatus] = useState(null);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [mobileView, setMobileView] = useState("conversation");
  const [trialState, setTrialState] = useState({ active: false, count: 0, status: "idle" });
  const [agentTrial, setAgentTrial] = useState(null);
  const [planningRequestActive, setPlanningRequestActive] = useState(false);
  const [mobileKeyboardOpen, setMobileKeyboardOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversationCollapsed, setConversationCollapsed] = useState(true);
  const [draftContext, setDraftContext] = useState("");
  const [status, setStatus] = useState({ loading: true });
  const [mediaStatus, setMediaStatus] = useState({});
  const [imageAttachment, setImageAttachment] = useState(null);
  const composerRef = useRef(null);
  const requestSequenceRef = useRef(0);
  const actionInFlight = useRef(false);
  const [executionView, setExecutionView] = useState(null);
  const [executionReconnect, setExecutionReconnect] = useState(0);
  const executionWatchRef = useRef(null);
  const pendingCommandRef = useRef(null);
  useEffect(() => () => executionWatchRef.current?.abort(), []);
  useEffect(() => {
    if (trip?.tripId) {
      setMobileView("itinerary");
      setConversationCollapsed(true);
    }
  }, [trip?.tripId]);
  const openQuestionId = executionView?.status === "awaiting_input" && executionView.result?.question?.status === "open"
    ? executionView.result.question.questionId : null;
  useEffect(() => {
    if (!openQuestionId) return;
    // A new Trip opens the workbench; its necessary question must remain visible.
    // Polling the same question does not reopen a sheet the traveler closed.
    setConversationCollapsed(false);
    setMobileView("conversation");
  }, [trip?.tripId, openQuestionId]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    let focusFrame = 0;
    const updateKeyboardState = () => setMobileKeyboardOpen(shouldHideMobileNavigation({
      layoutWidth: window.innerWidth,
      layoutHeight: window.innerHeight,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      activeElement: document.activeElement,
    }));
    const updateAfterFocus = () => {
      window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(updateKeyboardState);
    };
    updateKeyboardState();
    viewport.addEventListener("resize", updateKeyboardState);
    document.addEventListener("focusin", updateAfterFocus);
    document.addEventListener("focusout", updateAfterFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      viewport.removeEventListener("resize", updateKeyboardState);
      document.removeEventListener("focusin", updateAfterFocus);
      document.removeEventListener("focusout", updateAfterFocus);
    };
  }, []);
  useEffect(() => {
    const handleWorkspaceShortcuts = (event) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setConversationCollapsed(false);
        setMobileView("conversation");
        window.requestAnimationFrame(() => composerRef.current?.focus());
      } else if (key === "b" && window.innerWidth >= 900) {
        event.preventDefault();
        setConversationCollapsed((current) => !current);
      }
    };
    window.addEventListener("keydown", handleWorkspaceShortcuts);
    return () => window.removeEventListener("keydown", handleWorkspaceShortcuts);
  }, []);
  const refreshConversations = useCallback(async () => {
    const [result, tripList] = await Promise.all([api.listConversations(true), api.listTrips()]);
    const activeConversations = result.conversations.filter((item) => !item.deletedAt);
    const removedConversations = result.conversations.filter((item) => item.deletedAt);
    const availableTripIds = new Set((tripList.trips ?? []).map((item) => item.tripId));
    setUnavailableTripIds(new Set(activeConversations.map((item) => item.tripId).filter((tripId) => tripId && !availableTripIds.has(tripId))));
    setConversations(activeConversations);
    setDeletedConversations(removedConversations);
    return activeConversations;
  }, []);
  const loadTrip = useCallback(async (tripId) => {
    if (!tripId) { setTrip(null); setPlan(null); setTripRecovery(null); return false; }
    try {
      const [control, nextPlan] = await Promise.all([api.control(tripId), api.plan(tripId)]);
      setTrip({
        tripId,
        destination: control.brief.destination,
        dates: control.brief.dates,
        durationDays: control.brief.durationDays,
        origin: control.brief.origin,
        arrivalMode: control.brief.arrivalMode,
        travelerCount: control.travelers.length,
        travelers: control.travelers,
        totalBudget: control.brief.totalBudget,
        pace: control.brief.pace,
      });
      setPlan(nextPlan);
      setAgentTrial((current) => nextPlan.itineraryTrial?.itinerary
        ? nextPlan.itineraryTrial
        : current?.tripId === tripId && current?.baseRevision === nextPlan.revision ? current : null);
      setTripRecovery(null);
      return true;
    } catch (error) {
      if (error.code !== "trip_not_found") throw error;
      setTrip(null);
      setPlan(null);
      setTripRecovery({ tripId });
      return false;
    }
  }, []);
  const selectConversation = useCallback(async (conversationId) => {
    executionWatchRef.current?.abort();
    actionInFlight.current = true;
    requestSequenceRef.current += 1;
    setPlanningRequestActive(false);
    setStatus({ loading: true });
    try {
      const selected = await api.conversation(conversationId);
      const loaded = await loadTrip(selected.tripId);
      setConversation(selected);
      setExecutionView(null);
      setAgentTrial(null);
      setImageAttachment(null);
      setMediaStatus({});
      setSelectedModelId(selected.modelId);
      setMobileView(loaded ? "itinerary" : "conversation");
      setConversationCollapsed(Boolean(loaded));
      setHistoryOpen(false);
      setStatus({});
    } catch (error) { setStatus({ error: messageError(error) }); }
    finally { actionInFlight.current = false; }
  }, [loadTrip]);
  useEffect(() => {
    if (!conversation?.conversationId || actionInFlight.current) return;
    const controller = new AbortController();
    executionWatchRef.current = controller;
    const sequence = requestSequenceRef.current;
    const current = () => !controller.signal.aborted && sequence === requestSequenceRef.current;
    void (async () => {
      const { runs } = await api.conversationRuns(conversation.conversationId, controller.signal);
      if (!current() || !runs[0]) return;
      const run = runs.find(isRunActive) ?? runs[0];
      setExecutionView(run);
      if (!isRunActive(run)) return;
      setStatus({ loading: true });
      const result = await api.resumeRunView(run.runId, { signal: controller.signal, onProgress: (progress) => {
        if (current()) setExecutionView((previous) => ({ ...previous, ...progress }));
      } });
      if (!current()) return;
      setConversation(result.conversation);
      if (result.itineraryTrial?.itinerary) setAgentTrial(result.itineraryTrial);
      await loadTrip(result.tripId ?? result.conversation.tripId);
      await refreshConversations();
      if (current()) setStatus({ activities: result.activities, turnStatus: result.status });
    })().catch((error) => {
      if (current()) { setExecutionView((previous) => previous ? { ...previous, connection: "offline" } : null); setStatus({ error: messageError(error) }); }
    });
    return () => controller.abort();
  }, [conversation?.conversationId, executionReconnect, loadTrip, refreshConversations]);
  useEffect(() => {
    if (executionView?.status !== "awaiting_input" || executionView.result?.question?.status !== "open" || !conversation?.conversationId) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || actionInFlight.current || document.hidden) return;
      checking = true;
      try {
        const { runs } = await api.conversationRuns(conversation.conversationId, controller.signal);
        if (controller.signal.aborted || actionInFlight.current) return;
        const latest = runs.find(isRunActive) ?? runs[0];
        if (latest?.runId !== executionView.runId) setExecutionReconnect(value => value + 1);
        else if (latest) setExecutionView(previous => ({ ...previous, ...latest }));
      } catch { /* The saved card remains usable offline; answer validation is authoritative. */ }
      finally { checking = false; }
    }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [conversation?.conversationId, executionView?.runId, executionView?.status, executionView?.result?.question?.status]);
  useEffect(() => {
    Promise.all([refreshConversations(), api.providerStatus()]).then(async ([items, providers]) => {
      setProviderStatus(providers);
      setSelectedModelId((current) => current || providers.modelSelection?.defaultModelId || "deepseek-v4-flash");
      if (items[0]) await selectConversation(items[0].conversationId);
      else setStatus({});
    }).catch((error) => setStatus({ error: messageError(error) }));
  }, [refreshConversations, selectConversation]);
  const canLeaveJourney = () => {
    if (((status.loading || actionInFlight.current) && !isRunActive(executionView)) || pendingSync || failedDraft || draft.trim() || imageAttachment) {
      setConversationManagementStatus({ error: pick("当前旅行有未完成的操作或未发送的内容，请先返回处理，避免丢失。", "Finish the current operation or handle the unsent draft before switching trips.") });
      return false;
    }
    return true;
  };
  const createConversation = async () => {
    if (!canLeaveJourney()) return;
    executionWatchRef.current?.abort();
    actionInFlight.current = true;
    requestSequenceRef.current += 1;
    setPlanningRequestActive(false);
    setStatus({ loading: true });
    try {
      const modelId = selectedModelId || providerStatus?.modelSelection?.defaultModelId || "deepseek-v4-flash";
      const created = await api.createConversation({ modelId });
      setConversation(created); setTrip(null); setPlan(null); setTripRecovery(null); setAgentTrial(null); setDraft(""); setDraftContext(""); setImageAttachment(null); setMediaStatus({}); setConversationCollapsed(false); setMobileView("conversation"); setHistoryOpen(false);
      setExecutionView(null);
      setSelectedModelId(created.modelId);
      await refreshConversations(); setStatus({});
    } catch (error) { setStatus({ error: messageError(error) }); }
    finally { actionInFlight.current = false; }
  };
  const deleteConversation = async () => {
    const target = conversationToDelete;
    if (!target || conversationManagementStatus.loading) return;
    if (target.conversationId === conversation?.conversationId && !canLeaveJourney()) return;
    setConversationManagementStatus({ loading: true });
    try {
      await api.deleteConversation(target.conversationId);
      const remaining = await refreshConversations();
      const deletedActiveConversation = conversation?.conversationId === target.conversationId;
      setConversationToDelete(null);
      setConversationManagementStatus({ notice: pick("会话已移入最近删除，关联行程仍保留。", "Conversation moved to recently deleted; the linked trip is preserved.") });
      if (deletedActiveConversation) {
        if (remaining[0]) await selectConversation(remaining[0].conversationId);
        else {
          setConversation(null); setTrip(null); setPlan(null); setTripRecovery(null); setDraft(""); setDraftContext(""); setMobileView("conversation"); setConversationCollapsed(false); setStatus({});
        }
      }
    } catch (error) {
      setConversationManagementStatus({ error: messageError(error) });
    }
  };
  const restoreConversation = async (target) => {
    if (!target?.conversationId || conversationManagementStatus.loading) return;
    if (!canLeaveJourney()) return;
    setConversationManagementStatus({ loading: true });
    try {
      await api.restoreConversation(target.conversationId);
      await refreshConversations();
      setConversationManagementStatus({ notice: pick("会话已恢复。", "Conversation restored.") });
      await selectConversation(target.conversationId);
    } catch (error) {
      setConversationManagementStatus({ error: messageError(error) });
    }
  };
  const retryJourneySync = async () => {
    if (!pendingSync || actionInFlight.current) return;
    actionInFlight.current = true;
    setStatus({ loading: true });
    try {
      if (pendingSync.tripId) await loadTrip(pendingSync.tripId);
      await refreshConversations();
      setPendingSync(null);
      setStatus({});
    } catch (error) { setStatus({ error: messageError(error) }); }
    finally { actionInFlight.current = false; }
  };
  const restoreFailedDraft = () => {
    if (!failedDraft) return;
    if (draft.trim() || imageAttachment) {
      setStatus({ error: pick("输入框里有新内容，请先保留或清空它，再恢复上一条。", "Keep or clear the new draft before restoring the previous request.") });
      return;
    }
    setDraft(failedDraft.text);
    setImageAttachment(failedDraft.attachment);
    setFailedDraft(null);
    setStatus({});
    setMobileView("conversation");
    setConversationCollapsed(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };
  const submitMessage = async (text, { planningContext = null, answerTo = null } = {}) => {
    const question = executionView?.status === "awaiting_input" && executionView.result?.question?.status === "open" ? executionView.result.question : null;
    answerTo ??= question && !planningContext && !imageAttachment ? { runId: executionView.runId, questionId: question.questionId } : null;
    const attachment = imageAttachment;
    const clean = text.trim() || (attachment ? pick("请结合这张旅行图片理解我的需求，并直接继续核验和规划。", "Use this travel image to understand my request, then continue checking sources and planning.") : "");
    if (!clean || status.loading || actionInFlight.current || pendingSync) return;
    if (failedDraft) {
      setStatus({ error: pick("请先恢复或放弃上一条待恢复内容，避免丢失它。", "Restore or discard the previous request before sending another.") });
      return;
    }
    actionInFlight.current = true;
    const requestSequence = ++requestSequenceRef.current;
    executionWatchRef.current?.abort();
    const controller = new AbortController();
    executionWatchRef.current = controller;
    const commandKey = JSON.stringify([conversation?.conversationId ?? pendingCommandRef.current?.conversationId, clean, selectedModelId, attachment?.data, planningContext, answerTo]);
    if (pendingCommandRef.current?.key !== commandKey) pendingCommandRef.current = { key: commandKey, id: crypto.randomUUID() };
    let acceptedRunId = null;
    setPlanningRequestActive(Boolean(planningContext));
    setStatus({ loading: true }); setPendingText(clean); setDraft(""); setDraftContext(""); setImageAttachment(null); setMediaStatus({});
    try {
      let current = conversation;
      const modelId = selectedModelId || providerStatus?.modelSelection?.defaultModelId || "deepseek-v4-flash";
      if (!current) {
        current = await api.createConversation({ modelId });
        setConversation(current);
      }
      pendingCommandRef.current.conversationId = current.conversationId;
      pendingCommandRef.current.key = JSON.stringify([current.conversationId, clean, selectedModelId, attachment?.data, planningContext, answerTo]);
      const { receipt: result, syncError } = await runJourneyAction({
        perform: () => api.sendConversationMessage(current.conversationId, clean, modelId, attachment ? [{ mimeType: attachment.mimeType, data: attachment.data }] : undefined, planningContext, {
          requestId: pendingCommandRef.current.id, signal: controller.signal, answerTo,
          onProgress: (progress) => {
            acceptedRunId = progress.runId ?? acceptedRunId;
            if (requestSequence === requestSequenceRef.current) setExecutionView((previous) => ({ ...(previous?.runId === progress.runId ? previous : {}), ...progress }));
          },
        }),
        onDelivered: (result) => {
          if (requestSequence !== requestSequenceRef.current) return;
          pendingCommandRef.current = null;
          setConversation(result.conversation);
          setSelectedModelId(result.conversation.modelId);
          setPendingText("");
          setPendingSync({ tripId: result.tripId ?? result.conversation.tripId, reason: "message" });
        },
        synchronize: async (result) => {
          if (requestSequence !== requestSequenceRef.current) return;
          await loadTrip(result.tripId ?? result.conversation.tripId);
          await refreshConversations();
        },
      });
      if (requestSequence !== requestSequenceRef.current) return;
      if (!syncError) setPendingSync(null);
      if (result.itineraryTrial?.itinerary) setAgentTrial(result.itineraryTrial);
      setStatus({ activities: result.activities ?? [], turnStatus: result.status });
      if (result.multimodal?.status === "completed") setMediaStatus({ notice: pick("图片已在本轮参与理解、核验和规划；原图未保存。", "The image was used for this planning turn and was not saved.") });
    } catch (error) {
      if (requestSequence === requestSequenceRef.current) {
        // Never overwrite text or a photo the traveler added while waiting.
        if (acceptedRunId) setExecutionView((previous) => ({ ...previous, connection: "offline" }));
        else if (["question_stale", "question_already_answered"].includes(error.code)) {
          setExecutionView(previous => ({ ...previous, result: { ...previous?.result, question: { ...previous?.result?.question, status: "stale" } } }));
          setDraft(clean);
          if (conversation?.tripId) await loadTrip(conversation.tripId);
        } else setFailedDraft({ text: clean, attachment });
        setStatus({ error: messageError(error) });
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) { actionInFlight.current = false; setPlanningRequestActive(false); setPendingText(""); }
    }
  };
  const acceptProposal = async (proposalId, selections, { partial = false, previewId = undefined, baseRevision = undefined, routeModes = undefined } = {}) => {
    if (!trip?.tripId || status.loading || actionInFlight.current || pendingSync) return;
    actionInFlight.current = true;
    setStatus({ loading: true });
    try {
      let routeRefreshFailed = false;
      const { syncError } = await runJourneyAction({
        perform: async () => {
          const result = await api.accept(trip.tripId, proposalId, selections, partial, previewId, baseRevision, routeModes);
          if (result.status !== "committed") throw Object.assign(new Error(result.status), { code: result.validation?.reason ?? result.status });
          return result;
        },
        onDelivered: () => {
          setAgentTrial(null);
          setPendingSync({ tripId: trip.tripId, reason: "confirmation" });
        },
        synchronize: async (result) => {
          if (!["completed", "partial"].includes(result.mobility?.status)) {
            try { await api.refreshMobility(trip.tripId); }
            catch { routeRefreshFailed = true; }
          }
          await loadTrip(trip.tripId);
        },
      });
      if (!syncError) setPendingSync(null);
      setStatus({
        activities: [{ toolName: "accept_trip_change", status: "committed" }],
        ...(routeRefreshFailed ? { error: pick("安排已确认。路线更新暂未完成，请检查路线状态；不需要重复确认。", "Choices confirmed. Route refresh is incomplete; check route status without confirming again.") } : {}),
      });
    } catch (error) { setStatus({ error: messageError(error) }); }
    finally { actionInFlight.current = false; }
  };
  const rejectProposal = async (proposalId) => {
    if (!trip?.tripId || status.loading || actionInFlight.current || pendingSync) return;
    actionInFlight.current = true;
    setStatus({ loading: true });
    try {
      const { syncError } = await runJourneyAction({
        perform: () => api.reject(trip.tripId, proposalId),
        onDelivered: () => setPendingSync({ tripId: trip.tripId, reason: "change" }),
        synchronize: () => loadTrip(trip.tripId),
      });
      if (!syncError) setPendingSync(null);
      setStatus({ activities: [{ toolName: "reject_trip_change", status: "rejected_by_user" }] });
    } catch (error) { setStatus({ error: messageError(error) }); }
    finally { actionInFlight.current = false; }
  };
  const discardAgentTrial = async () => {
    const current = agentTrial;
    setAgentTrial(null);
    if (!trip?.tripId || !current?.proposalId) return;
    try {
      await api.discardItineraryTrial(trip.tripId, current.proposalId, plan?.revision);
      await loadTrip(trip.tripId);
    } catch (error) {
      setAgentTrial(current);
      setStatus({ error: messageError(error) });
    }
  };
  const submitFeedback = async (node, input) => {
    if (!trip?.tripId || !node?.nodeId || !plan) throw Object.assign(new Error("feedback_context_unavailable"), { code: "feedback_context_unavailable" });
    const result = await api.submitFeedback(trip.tripId, { ...input, nodeId: node.nodeId, baseRevision: plan.revision });
    if (result.status !== "committed") throw Object.assign(new Error(result.status), { code: result.validation?.reason ?? result.status });
    await loadTrip(trip.tripId);
    return result;
  };
  const prepareDraft = useCallback((text, contextLabel = "") => {
    setDraft(text);
    setDraftContext(contextLabel);
    setConversationCollapsed(false);
    setMobileView("conversation");
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(text.length, text.length);
      composerRef.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
    });
  }, []);
  const updateDraft = useCallback((value) => {
    setDraft(value);
    if (!value.trim()) setDraftContext("");
  }, []);
  const preparePhotoDraft = (photo) => {
    if ((draft.trim() || imageAttachment) && !window.confirm(pick("输入框已有未发送的内容，要替换为这张照片的规划请求吗？", "Replace the unsent draft with a planning request for this photo?"))) return false;
    setImageAttachment({ ...photo, savedInJournal: true, previewUrl: `data:${photo.mimeType};base64,${photo.data}` });
    setMediaStatus({ notice: pick("请检查照片与要求，确认发送后才会交给旅行助手。", "Review the photo and request. Nothing is sent to the Travel Agent until you send.") });
    prepareDraft(pick(`这是我在${photo.placeTitle}拍的照片。${photo.note ? `我的记录：${photo.note}。` : ""}请结合当前行程，帮我考虑接下来去哪里或吃什么；照片中的推测请标明，先给建议，不要直接改变行程。`, `This is my photo at ${photo.placeTitle}. ${photo.note ? `My note: ${photo.note}. ` : ""}Help me choose what to see or eat next in this trip. Label guesses from the photo; suggest first without changing the itinerary.`), pick("来自我的旅行手账", "From my travel journal"));
    return true;
  };
  const inspectImage = useCallback(async (file) => {
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 3_000_000) {
      setMediaStatus({ error: pick("请选择不超过 3MB 的 JPG、PNG 或 WebP 图片。", "Choose a JPG, PNG or WebP image no larger than 3 MB.") });
      return;
    }
    setMediaStatus({ loading: true });
    try {
      const data = await imagePayload(file);
      setImageAttachment({ name: file.name.slice(0, 120), mimeType: file.type, data, previewUrl: `data:${file.type};base64,${data}` });
      setMediaStatus({ notice: pick("图片已就绪。补充一句你想让旅行助手做什么，然后一起发送。", "Image ready. Add what you want the Travel Agent to do, then send both together.") });
      setConversationCollapsed(false);
      setMobileView("conversation");
      window.requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setMediaStatus({ error: pick("这张图片暂时无法读取，请换一张或直接描述。", "This image could not be read. Try another one or describe it directly.") });
    }
  }, [pick]);
  const updateReadiness = useCallback(async (signalId, nextStatus) => {
    if (!trip?.tripId) return;
    try {
      await api.updateReadiness(trip.tripId, signalId, nextStatus);
      await loadTrip(trip.tripId);
      setStatus({ activities: [{ toolName: "trip_readiness", status: "updated" }] });
    } catch (error) {
      setStatus({ error: messageError(error) });
    }
  }, [trip?.tripId, loadTrip]);
  const quickReplies = quickRepliesForTrip(trip, locale);

  const handleTrialStateChange = useCallback((next) => setTrialState((current) => current.active === next.active && current.count === next.count && current.status === next.status ? current : next), []);
  const isStarting = !trip && !tripRecovery;
  const isWelcoming = isStarting && !conversation?.messages?.length && !pendingText;
  const assistant = (<section className="conversation-panel atlas-conversation">
        <header className="conversation-header"><div><h2>{tripRecovery ? pick("恢复这趟旅行", "Recover this trip") : pick("和旅行助手对话", "Talk with the Travel Agent")}</h2><small className="conversation-header-sub">{pick("从一句话开始", "Start with one sentence")}</small></div><div className="conversation-header-actions">{trip ? <span className="draft-state"><CheckCircle weight="fill" />{pick("已记住旅行要求", "Requirements saved")}</span> : tripRecovery ? <span className="draft-state recovery"><ArrowsClockwise />{pick("草案需恢复", "Draft needs recovery")}</span> : <span className="draft-state muted">{pick("从一句话开始", "Start with one sentence")}</span>}<button className="conversation-collapse-button" type="button" onClick={() => { setConversationCollapsed(true); if (mobileView === "conversation") setMobileView("itinerary"); }} aria-label={pick("关闭旅行助手", "Close travel assistant")}><X /><span>{pick("关闭", "Close")}</span></button></div></header>
        {status.error && <div className="chat-error" role="alert"><WarningCircle />{status.error}<button onClick={() => setStatus({})}>{pick("关闭提示", "Dismiss")}</button></div>}
        {isWelcoming ? <ConversationIntro /> : <MessageScroller busy={status.loading} resetKey={conversation?.conversationId ?? "new"} jumpLabel={pick("回到最新消息", "Jump to latest")}>{!conversation?.messages?.length ? pendingText && status.loading ? <><article className="chat-message user pending"><div className="message-avatar">你</div><div className="message-copy"><MessageBody text={pendingText} /><time>正在发送</time></div></article><ThinkingMessage hasPlan={Boolean(trip)} onBackground={() => { setConversationCollapsed(true); setMobileView("itinerary"); }} /></> : <ConversationIntro /> : <>{conversation.messages.map((message) => <MessageBubble key={message.messageId} message={message} />)}{status.loading && <ThinkingMessage hasPlan={Boolean(trip)} onBackground={() => { setConversationCollapsed(true); setMobileView("itinerary"); }} />}<ActivityStrip activities={status.activities} /></>}</MessageScroller>}
        {trip && quickReplies.length ? <div className="quick-replies" aria-label="快捷调整旅行要求">{quickReplies.map((reply) => <button key={reply.label} type="button" disabled={status.loading} onClick={() => reply.prefill ? prepareDraft(reply.prefill, reply.label) : submitMessage(reply.text)}>{reply.label}</button>)}</div> : null}
        {mediaStatus.error || mediaStatus.notice ? <div className={`media-notice ${mediaStatus.error ? "error" : ""}`} role={mediaStatus.error ? "alert" : "status"}>{mediaStatus.error || mediaStatus.notice}<button type="button" onClick={() => setMediaStatus({})}>{pick("关闭", "Dismiss")}</button></div> : null}
        <ExecutionProgress run={executionView} locale={locale} onAnswer={(answer, answerTo) => submitMessage(answer, { answerTo })}
          onReviewDraft={() => { setConversationCollapsed(true); setMobileView("map"); }}
          onStop={async () => { try { const stopped = await api.cancelRun(executionView.runId); setExecutionView((current) => ({ ...current, ...stopped })); } catch (error) { setStatus((current) => ({ ...current, error: messageError(error) })); } }}
          onReconnect={() => { requestSequenceRef.current++; executionWatchRef.current?.abort(); actionInFlight.current = false; setExecutionReconnect((value) => value + 1); }}
          onContinue={() => executionView.requiresImage ? prepareDraft(pick("请结合重新附上的图片，从当前已保存的旅行继续规划。", "Continue from the saved trip using the image I attach again."), pick("继续规划", "Continue planning")) : submitMessage(pick("请先读取当前已保存的旅行要求、已完成的工作和未完成事项，继续规划；不要重复提交已经确认的操作。", "Read the saved trip, completed work and open questions, then continue planning without repeating confirmed actions."))}
        />
        <Composer value={draft} onChange={updateDraft} onSubmit={submitMessage} loading={status.loading} blocked={Boolean(pendingSync || failedDraft)} inputRef={composerRef} contextLabel={draftContext} onClearContext={() => { setDraft(""); setDraftContext(""); composerRef.current?.focus(); }} onInspectImage={inspectImage} imageAttachment={imageAttachment} onRemoveImage={() => { setImageAttachment(null); setMediaStatus({}); composerRef.current?.focus(); }} imageLoading={mediaStatus.loading} onLinkPrompt={() => prepareDraft(locale === "en" ? "I want to import a travel share link:\n\nIf this link cannot be read safely, do not guess its content. Tell me the next verifiable step." : "我想导入一个旅行分享链接：\n\n如果当前无法安全读取这个链接，请不要猜测内容；告诉我可以核验的下一步。", pick("旅行分享链接", "Travel share link"))} />
        {failedDraft ? <div className="journey-draft-recovery" role="status"><p>{pick("上一条请求未收到成功回执，文字和照片已保留。恢复前请先检查对话，避免重复发送。", "No success receipt was received. Text and photo are kept. Check the conversation before resending.")}</p><div><button type="button" onClick={restoreFailedDraft}>{pick("恢复到输入框", "Restore draft")}</button><button type="button" onClick={() => { if (window.confirm(pick("放弃这条待恢复的文字和照片？", "Discard the saved text and photo?"))) setFailedDraft(null); }}>{pick("放弃待恢复内容", "Discard saved draft")}</button></div></div> : null}
        {isWelcoming ? <><StarterSuggestions onPrompt={(prompt) => prepareDraft(prompt, "")} /><p className="journey-start-note"><CheckCircle />{pick("先规划，无需登录。所有安排都由你确认。", "Plan first, no sign-in needed. You confirm every change.")}</p></> : null}
      </section>);
  return <main className={`atlas-shell ${isStarting ? "is-starting" : "has-journey"} ${isWelcoming ? "is-welcoming" : ""} ${mobileKeyboardOpen ? "mobile-keyboard-open" : ""}`}>
    <header className="atlas-topbar"><a className="atlas-brand" href="/" onClick={(event) => { event.preventDefault(); if (trip) setMobileView("itinerary"); }} aria-label="Travel Agent"><Compass weight="fill" /><span>Travel Agent<span className="atlas-brand-dot">.</span></span></a><button className="atlas-history" type="button" onClick={() => setHistoryOpen(true)}><List /><span>{pick("我的旅行", "My trips")}</span></button><div className="atlas-topbar-end">{trip || tripRecovery ? <button type="button" className="atlas-assistant-trigger" onClick={() => setConversationCollapsed(false)} aria-haspopup="dialog">{status.loading ? <CircleNotch className="spin" /> : <Sparkle weight="fill" />}<span>{status.loading ? pick("正在规划", "Planning") : pick("旅行助手", "Assistant")}</span><kbd>⌘ K</kbd></button> : null}<button className="atlas-locale" type="button" onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")} aria-label={locale === "en" ? "切换为中文" : "Switch to English"}><Globe />{locale === "en" ? "EN" : "中"}</button><button className="atlas-account" type="button" onClick={session.guest ? onRequestLogin : onAccount} aria-label={session.guest ? pick("登录保存旅行", "Sign in to keep your trips") : pick("账号设置", "Account settings")}><User /><span>{session.guest ? pick("登录", "Sign in") : session.displayName || pick("旅行者", "Traveler")}</span></button></div></header>
    {historyOpen ? <OverlaySurface overlayClassName="history-overlay" surfaceClassName="history-drawer" label={pick("旅行与对话管理", "Trip and conversation management")} onClose={() => setHistoryOpen(false)}><button className="history-close icon-button" type="button" onClick={() => setHistoryOpen(false)} aria-label={pick("关闭旅行对话记录", "Close trip conversations")}><X /></button><ConversationPicker conversations={conversations} deletedConversations={deletedConversations} activeId={conversation?.conversationId} unavailableTripIds={unavailableTripIds} onPick={(id) => { if (canLeaveJourney()) void selectConversation(id); }} onNew={createConversation} onDelete={(target) => { setConversationManagementStatus({}); setConversationToDelete(target); }} onRestore={restoreConversation} managementStatus={conversationManagementStatus} onDismissStatus={() => setConversationManagementStatus({})} /></OverlaySurface> : null}
    {pendingSync ? <div className="journey-sync-banner" role="status"><div><strong>{pick(pendingSync.reason === "message" ? "消息已送达" : pendingSync.reason === "confirmation" ? "安排已确认" : "变更已保存", pendingSync.reason === "message" ? "Message delivered" : pendingSync.reason === "confirmation" ? "Choices confirmed" : "Change saved")}</strong><span>{pick("正在等待最新页面信息，不需要重复提交。", "Waiting for the latest page data. Do not submit again.")}</span></div><button type="button" disabled={status.loading} onClick={retryJourneySync}><ArrowsClockwise />{pick(status.loading ? "正在同步" : "重新读取", status.loading ? "Syncing" : "Reload saved data")}</button></div> : null}
    {conversationToDelete ? <OverlaySurface overlayClassName="conversation-delete-backdrop" surfaceClassName="conversation-delete-dialog" labelledBy="conversation-delete-title" closeOnBackdrop={!conversationManagementStatus.loading} closeOnEscape={!conversationManagementStatus.loading} onClose={() => { if (!conversationManagementStatus.loading) setConversationToDelete(null); }}><span><Trash weight="duotone" /></span><h3 id="conversation-delete-title">{pick("删除这段对话？", "Delete this conversation?")}</h3><p>{pick("会话会移入“最近删除”，关联行程和已确认选择不会删除，可以随时恢复。", "The conversation moves to Recently deleted. Its linked trip and confirmed choices remain available for restoration.")}</p>{conversationManagementStatus.error ? <small role="alert">{conversationManagementStatus.error}</small> : null}<footer><button type="button" className="quiet-action" disabled={conversationManagementStatus.loading} onClick={() => setConversationToDelete(null)}>{pick("取消", "Cancel")}</button><button type="button" className="conversation-delete-confirm" disabled={conversationManagementStatus.loading} onClick={deleteConversation}>{conversationManagementStatus.loading ? <CircleNotch className="spin" /> : <Trash />}{pick("移入最近删除", "Move to recently deleted")}</button></footer></OverlaySurface> : null}
    <div className="atlas-main">{isStarting ? <div className="atlas-start">{assistant}</div> : <PlanCanvas conversation={conversation} trip={trip} plan={plan} agentTrial={agentTrial} planningRequestActive={planningRequestActive} tripRecovery={tripRecovery} dataUnavailable={providerStatus?.data?.amapOfficialMcp === "blocked" && !["available_read_only", "trial_read_only"].includes(providerStatus?.data?.fliggyFlyAi) && providerStatus?.data?.tuniuOfficialMcp !== "available_read_only"} onRefresh={() => loadTrip(conversation?.tripId).catch((error) => setStatus({ error: messageError(error) }))} onRetryResearch={() => submitMessage(locale === "en" ? "Continue planning and research the connected trip again." : "继续规划，请重新查找吃、住、行、玩方案。") } onRecoverTrip={() => submitMessage(locale === "en" ? "Rebuild the trip draft from the requirements already stated in this conversation and continue planning the connected trip." : "请根据这段对话中已经说明的旅行要求，重新建立旅行草案并继续规划吃、住、行、玩。") } onAcceptProposal={acceptProposal} onRejectProposal={rejectProposal} onSubmitFeedback={submitFeedback} onUpdateReadiness={updateReadiness} onRequestLogin={onRequestLogin} onPrefill={prepareDraft} onPlanPhoto={preparePhotoDraft} onRunPlanning={(prompt, planningContext) => submitMessage(prompt, { planningContext })} onClearAgentTrial={discardAgentTrial} onFocusMap={() => setConversationCollapsed(true)} onTrialStateChange={handleTrialStateChange} activeMobileView={mobileView} onMobileViewChange={setMobileView} loading={status.loading || Boolean(pendingSync)} />}</div>
    {!isStarting && !conversationCollapsed ? <OverlaySurface overlayClassName="atlas-assistant-overlay" surfaceClassName="atlas-assistant-sheet" label={pick("旅行助手", "Travel assistant")} initialFocusRef={composerRef} onClose={() => { setConversationCollapsed(true); if (mobileView === "conversation") setMobileView("itinerary"); }}>{assistant}</OverlaySurface> : null}
    {!isStarting ? <nav className="atlas-mobile-nav" aria-label={pick("旅行导航", "Travel navigation")}><button type="button" aria-current={!["map", "journal"].includes(mobileView) ? "page" : undefined} onClick={() => setMobileView("itinerary")}><Compass />{pick("发现", "Explore")}</button><button type="button" aria-current={mobileView === "map" ? "page" : undefined} onClick={() => setMobileView("map")}><MapTrifold />{pick("行程", "Trip")}{trialState.count ? <span>{trialState.count}</span> : null}</button><button type="button" aria-current={mobileView === "journal" ? "page" : undefined} onClick={() => setMobileView("journal")}><ImageSquare />{pick("手账", "Journal")}</button><button type="button" onClick={() => setConversationCollapsed(false)}><Sparkle />{pick("助手", "Assistant")}</button></nav> : null}
    {status.error && conversationCollapsed ? <div className="workspace-toast error" role="alert"><WarningCircle /><span>{status.error}</span><button type="button" aria-label={pick("关闭提示", "Dismiss")} onClick={() => setStatus({})}><X /></button></div> : null}
  </main>;
}

export function TravelApp() {
  const [locale, setLocale] = useState(initialUiLocale);
  const [session, setSession] = useState(undefined);
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [health, setHealth] = useState(null);
  const [authProviders, setAuthProviders] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountTab, setAccountTab] = useState("profile");
  const [desktopEvidenceOpen, setDesktopEvidenceOpen] = useState(false);
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    window.localStorage.setItem("travel-agent-ui-locale", locale);
  }, [locale]);
  useEffect(() => {
    let active = true;
    let unsubscribe = null;
    const query = new URLSearchParams(window.location.search);
    const nextAuthError = query.get("auth_error");
    setAuthError(nextAuthError);
    const applyDesktopAuthorization = async (payload) => {
      if (!payload || !active) return null;
      if (payload.authError) {
        setAuthError(payload.authError);
        setLoginOpen(true);
        return null;
      }
      if (!payload.code) return null;
      try {
        const authorized = await api.desktopExchange(payload.code);
        if (authorized.accessToken) await setDesktopAccessToken(authorized.accessToken);
        if (active) {
          setSession(authorized);
          setLoginOpen(false);
          if (authorized.linked) { setAccountTab("connections"); setAccountOpen(true); }
          setAuthError(null);
        }
        return authorized;
      } catch (error) {
        if (active) {
          setAuthError(error.code ?? "auth_login_failed");
          setLoginOpen(true);
        }
        return null;
      }
    };
    const restore = async () => {
      const [restoredSession, nextHealth, nextProviders] = await Promise.all([api.session().catch((error) => { if (error.code === "authentication_required") return null; throw error; }), api.health().catch(() => null), api.authProviders().catch(() => null)]);
      let nextSession = restoredSession;
      if (!nextSession) {
        nextSession = await api.createGuestSession().catch(() => null);
        if (nextSession?.accessToken) await setDesktopAccessToken(nextSession.accessToken);
      }
      const pendingDesktopAuthorization = await window.travelDesktop?.takePendingAuthCallback?.();
      if (pendingDesktopAuthorization) nextSession = await applyDesktopAuthorization(pendingDesktopAuthorization) ?? nextSession;
      if (!active) return;
      setSession(nextSession);
      setHealth(nextHealth);
      setAuthProviders(nextProviders);
      const returningToAccount = query.get("account") === "connections" && nextSession && !nextSession.guest;
      setAccountOpen(Boolean(returningToAccount));
      if (returningToAccount) setAccountTab("connections");
      setLoginOpen(Boolean(nextAuthError) && !returningToAccount);
      if (query.has("auth") || query.has("auth_error")) {
        query.delete("auth");
        query.delete("auth_error");
        const nextQuery = query.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`);
      }
    };
    unsubscribe = window.travelDesktop?.onAuthCallback?.((payload) => { void applyDesktopAuthorization(payload); }) ?? null;
    setRestoreError(false);
    void restore().catch(() => { if (active) setRestoreError(true); });
    return () => { active = false; unsubscribe?.(); };
  }, [restoreAttempt]);
  useEffect(() => window.travelDesktop?.onEvidenceState?.((state) => setDesktopEvidenceOpen(state?.open === true)), []);
  const acceptSession = async (nextSession) => { if (nextSession?.accessToken) await setDesktopAccessToken(nextSession.accessToken); setSession(nextSession); setLoginOpen(false); setAuthError(null); };
  const logout = async () => {
    await api.logout();
    setAccountOpen(false);
    await clearDesktopAccessToken();
    const guest = await api.createGuestSession().catch(() => null);
    if (guest?.accessToken) await setDesktopAccessToken(guest.accessToken);
    setSession(guest);
  };
  const localeContext = useMemo(() => ({ locale, setLocale, pick: (zh, en) => locale === "en" ? en : zh }), [locale]);
  if (session === undefined) return <UiLocaleContext.Provider value={localeContext}><main className="app-loading">{restoreError ? <div className="account-restore-error" role="alert"><WarningCircle /><p>{locale === "en" ? "Unable to connect. Your saved sign-in has been kept." : "暂时无法连接，已保留原有登录信息。"}</p><button type="button" className="account-secondary" onClick={() => setRestoreAttempt((value) => value + 1)}>{locale === "en" ? "Retry connection" : "重新连接"}</button></div> : <><CircleNotch className="spin" />{locale === "en" ? "Restoring session" : "正在恢复会话"}</>}</main></UiLocaleContext.Provider>;
  if (!session) return <UiLocaleContext.Provider value={localeContext}><LoginScreen locale={locale} onSession={acceptSession} developmentAuthEnabled={health?.developmentAuthEnabled === true} providerStatus={authProviders} initialError={authError} /></UiLocaleContext.Provider>;
  return <UiLocaleContext.Provider value={localeContext}><TravelEditor key={session.userId} session={session} onAccount={() => { setAccountTab("profile"); setAccountOpen(true); }} onRequestLogin={() => setLoginOpen(true)} />{desktopEvidenceOpen ? <button type="button" className="desktop-evidence-close" onClick={() => window.travelDesktop.closeEvidenceSource()}><X />{locale === "en" ? "Close original" : "收起原文"}</button> : null}{accountOpen && !session.guest ? <AccountCenter session={session} locale={locale} providerStatus={authProviders} initialTab={accountTab} initialError={authError} onClose={() => { setAccountOpen(false); setAuthError(null); }} onSession={setSession} onLogout={logout} onLogin={() => { setAccountOpen(false); setLoginOpen(true); }} /> : null}{loginOpen ? <LoginScreen locale={locale} embedded onContinue={() => { setLoginOpen(false); setAuthError(null); }} onSession={acceptSession} developmentAuthEnabled={health?.developmentAuthEnabled === true} providerStatus={authProviders} initialError={authError} /> : null}</UiLocaleContext.Provider>;
}
