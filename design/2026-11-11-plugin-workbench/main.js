import L from "leaflet";
import "./style.css";

const $ = selector => document.querySelector(selector);
const escape = text => String(text).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const paths = { pin: '<path d="M12 21s6-5.4 6-11a6 6 0 0 0-12 0c0 5.6 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/>', walk:'<circle cx="14" cy="4" r="2"/><path d="m12 8-3 5-4 1m7-6 4 4 4 1M12 9l1 6-5 6m5-6 5 5"/>', train:'<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 10h14M9 18l-2 3m8-3 2 3"/><path d="M9 14h.01M15 14h.01"/>', fork:'<path d="M5 3v6a3 3 0 0 0 6 0V3M8 3v18M18 3c-4 3-4 9 0 9V3Zm0 9v9"/>', camera:'<path d="M3 7h4l2-3h6l2 3h4v13H3Z"/><circle cx="12" cy="13" r="4"/>', swap:'<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>', check:'<path d="m5 12 4 4 10-10"/>' };
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.pin}</svg>`;
const originals = [
  { id:"nishiki", place:"nishiki", name:"锦市场", local:"錦市場", type:"午餐与散步", role:"fork", start:"11:30", duration:"1小时", timeEnd:"12:30", coordinate:[35.005,135.7648], note:"不赶时间，先吃点东西再出发。", area:"四条河原町" },
  { id:"gion", place:"gion", name:"祇园与白川", local:"祇園・白川", type:"街巷散步", role:"walk", start:"13:00", duration:"1小时30分", timeEnd:"14:30", coordinate:[35.006,135.777], note:"沿白川慢慢走，中途找地方休息。", area:"祇园" },
  { id:"kiyomizu", place:"kiyomizu", name:"清水寺", local:"清水寺", type:"下午游览", role:"pin", start:"15:00", duration:"1小时30分", timeEnd:"16:30", coordinate:[34.9949,135.785], note:"保留充足时间，不把整条山道排满。", area:"东山" },
];
const alternatives = {
  nishiki:[{ place:"nishiki",name:"锦市场",local:"錦市場",coordinate:[35.005,135.7648],area:"四条河原町",note:"保留市场午餐与散步，餐厅和费用另行核对。" },{ place:"pontocho",name:"先斗町一带",local:"先斗町",coordinate:[35.0056,135.7703],area:"鸭川西岸",note:"以寻找一家坐下用餐的店为备选；营业与菜单仍需确认。" }],
  gion:[{ place:"gion",name:"祇园与白川",local:"祇園・白川",coordinate:[35.006,135.777],area:"祇园",note:"保留街巷散步，是否适合当日同行人仍需核对。" },{ place:"kamogawa",name:"鸭川河畔",local:"鴨川",coordinate:[35.0086,135.7721],area:"三条",note:"换成河畔休息与散步；天气和通行条件仍未核实。" }],
  kiyomizu:[{ place:"kiyomizu",name:"清水寺",local:"清水寺",coordinate:[34.9949,135.785],area:"东山",note:"保留东山游览。坡道、营业和预约条件仍需核对。" },{ place:"museum",name:"京都国立博物馆",local:"京都国立博物館",coordinate:[34.9908,135.7731],area:"七条",note:"作为室内参观的比较对象；展览、门票及开放日期尚未核实。" }],
};
const storageKey="travel-agent-ui-direction-demo-v1";
const defaults=()=>({ day:2, selected:"nishiki", expanded:null, choices:{}, times:{}, acknowledgments:{}, budget:9000, adopted:false, sourceVersion:{}, journal:"", journalDraft:null, panel:null, mobileMap:false });
let state;
try { state={...defaults(),...JSON.parse(localStorage.getItem(storageKey)||"null"),panel:null,mobileMap:false}; } catch { state=defaults(); }
let world = new URLSearchParams(location.search).get("world")==="lake" ? "lake" : "ceramic";
let previous=null, toastTimer, map, tileErrors=0;
const currentVisits = () => originals.map(visit => ({ ...visit, ...(state.choices[visit.id] || {}), ...(state.times[visit.id] || {}) }));
const visit = id => currentVisits().find(item=>item.id===id);
const toMinutes=time=>Number(time.slice(0,2))*60+Number(time.slice(3,5));
function conflictIds(){const ids=new Set(),items=currentVisits();for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(toMinutes(items[i].start)<toMinutes(items[j].timeEnd)&&toMinutes(items[j].start)<toMinutes(items[i].timeEnd)){ids.add(items[i].id);ids.add(items[j].id);}return [...ids];}
function referenceFor(id){const items=currentVisits(),index=items.findIndex(item=>item.id===id);return items[index>0?index-1:1];}
const conditionNames = { time:"到访的当地日期与时间还需核对", opening:"营业和预约条件尚未核实", cost:"费用尚未核实" };
function conditionText(item,key){if(key==="opening"&&item.role==="walk")return "通行与出入条件尚未核实";if(key==="cost")return item.role==="fork"?"餐饮价格、菜单与包含项目尚未核实":item.role==="walk"?"这段散步可能涉及的费用尚未核实":"门票、余票与包含项目尚未核实";return conditionNames[key];}
const globalKeys=["connections","budget","party","complete","follow"];
const globalInfo = {
  connections:{title:"往返与交通衔接",text:"你记录了去程和返程，但当天逐段交通、衔接和时间缓冲还没有完成核验。",ack:"我了解，目前的往返与逐段衔接尚未核验"},
  budget:{title:"预算与费用",text:"预算上限是 CNY 9,000。地点费用、汇率及完整费用尚未归集，不能据此判断整趟旅行是否在预算内。",ack:"我了解，完整费用和全程预算仍未核实"},
  party:{title:"同行人与出行要求",text:"2位成人，希望少走路、不赶时间。地点、交通、休息与设施是否满足这些要求，仍需逐项核实。",ack:"我了解，同行人的要求尚未对照全部安排核验"},
  complete:{title:"整趟旅行的范围",text:"当前草案包含已记录的往返和第2天的3次到访；住宿、其他日期与餐次尚未全部安排。",ack:"我了解，这不是已经核实完整的往返与每日路书"},
  follow:{title:"采用后的风险跟进",text:"目前仅有目的地天气检查能力，是否能检查仍取决于来源和日期覆盖。航班、营业、预约及交通衔接还没有持续覆盖。",ack:"我了解，未覆盖的风险不会被自动检查"},
};
function basis(id){
  const [scope,subject,kind]=id.split(":");
  if(scope==="visit") { const item=visit(subject); return JSON.stringify([item.place,kind==="cost" ? "2026-12-05" : [item.start,item.timeEnd],2,state.sourceVersion[subject]||0]); }
  if(subject==="complete") return "three-days-booked-trains-three-visits-no-hotel-v1";
  if(subject==="follow") return "kyoto-weather-only-v1";
  return JSON.stringify([subject,subject==="budget" ? state.budget : "party-2-reduce-walking",currentVisits().map(item=>[item.place,subject==="budget" ? "2026-12-05" : [item.start,item.timeEnd],state.sourceVersion[item.id]||0])]);
}
const known = id => state.acknowledgments[id]===basis(id);
const visitIds = item => Object.keys(conditionNames).map(kind=>`visit:${item.id}:${kind}`);
const pendingFor = item => visitIds(item).filter(id=>!known(id)).length;
const pendingGlobals = () => globalKeys.filter(key=>!known(`trip:${key}`));
const totalPending = () => currentVisits().reduce((sum,item)=>sum+pendingFor(item),0)+pendingGlobals().length;
function save(){localStorage.setItem(storageKey,JSON.stringify(state));}
function toast(message){clearTimeout(toastTimer);$(".toast").hidden=false;$(".toast").textContent=message;toastTimer=setTimeout(()=>$(".toast").hidden=true,3800);}
function setWorld(value){world=value;document.body.dataset.world=world;document.querySelectorAll(".review-strip button[data-world]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.world===world)));const url=new URL(location.href);url.searchParams.set("world",value);history.replaceState(null,"",url);requestAnimationFrame(()=>map?.invalidateSize());}
function renderDays(){
  const rows=[{id:1,date:"12.04",name:"抵达京都",small:"去程已记录"},{id:2,date:"12.05",name:"东山与鸭川",small:"3次到访"},{id:3,date:"12.06",name:"离开京都",small:"返程已记录"}];
  $(".days").innerHTML=rows.map(day=>`<button class="day-button ${state.day===day.id?"active":""}" data-day="${day.id}" aria-current="${state.day===day.id?"date":"false"}"><strong>第${day.id}天</strong><span>${day.date}</span><small>${day.name}</small></button>`).join("");
}
function conditionRows(item){return Object.keys(conditionNames).map(key=>{const id=`visit:${item.id}:${key}`;return `<label class="condition-row"><input type="checkbox" data-condition="${id}" ${known(id)?"checked":""} ${state.adopted?"disabled":""}><span>我了解，${escape(conditionText(item,key))}</span></label>`;}).join("");}
function renderDay(){
  const titles={1:["抵达京都","12月4日，周五 · 留一点时间安顿下来"],2:["东山与鸭川，慢慢走","12月5日，周六 · 都按京都当地时间安排"],3:["离开京都","12月6日，周日 · 先保留你已订的返程"]};
  $(".day-heading").innerHTML=`<h2>${titles[state.day][0]}</h2><p>${titles[state.day][1]}</p><div class="day-stats"><span>${icon("pin")}${state.day===2?"3次到访":"已记录交通"}</span><span>${icon("walk")}少走路，不赶时间</span></div>`;
  if(state.day!==2){$(".itinerary").innerHTML=`<article class="recorded"><span>你已记录 · 不代表来源已核验</span><h3>${state.day===1?"东京 → 京都":"京都 → 东京"}</h3><p>${state.day===1?"12:00 出发 · 14:15 到达":"15:00 出发 · 17:15 到达"}<br>新干线 · 2位乘坐人</p><button class="panel-action" data-panel="connections">核对衔接与待确认条件</button></article><div class="todo-visit"><h3>${state.day===1?"到达后的住宿仍待安排":"离开前留出一些空白"}</h3><p>${state.day===1?"没有把未选定的酒店填成正式安排，先与助手讨论位置和要求。":"早餐和前往车站的交通尚未安排；草案仍保留这个缺口。"}</p><button data-panel="complete">查看整趟旅行范围 ${icon("arrow")}</button></div>`;return;}
  $(".itinerary").innerHTML=currentVisits().map((item,index)=>{const pending=pendingFor(item),selected=state.selected===item.id,conflict=conflictIds().includes(item.id);return `${index?`<div class="leg">${icon("walk")}交通衔接仍待核验 <button data-panel="connections">查看</button></div>`:""}<article class="visit ${selected?"selected":""}" data-visit="${item.id}"><time class="visit-time">${item.start}</time><span class="visit-dot"></span><button class="visit-main" data-select="${item.id}"><div class="visit-kicker">${icon(item.role)}${item.type}<span>· ${item.area}</span></div><h3>${escape(item.name)}</h3><div class="visit-bottom"><span>${item.start}—${item.timeEnd} · ${item.duration}</span><span class="visit-badge ${conflict?"conflict":!pending?"acknowledged":""}">${conflict?"时间有重叠":pending?`${pending}项待确认`:"已知悉 · 仍未核实"}</span></div></button>${selected?`<div class="visit-actions"><button data-compare="${item.id}">${icon("swap")}${state.adopted?"提出调整":"比较或换一个"}</button>${!state.adopted?`<button data-time="${item.id}">调整时间</button>`:""}<button data-toggle="${item.id}">${state.expanded===item.id?"收起条件":"查看未知条件"}</button></div>${state.expanded===item.id?`<div class="visit-conditions"><p>${state.adopted?"你在采用时已知悉这些条件，它们仍未完成核验。":"先看清这一次到访的未知条件，再决定是否保留暂定。"}</p>${conditionRows(item)}</div>`:""}`:""}</article>`;}).join("");
}
function renderFooter(){
  const groups=currentVisits().filter(item=>pendingFor(item)).length,global=pendingGlobals().length;
  $(".footer-copy").innerHTML=state.adopted?'<strong>暂定行程 · 仍有14项未核实条件</strong><span>确认知悉不等于核验完成，变化不会自动改写安排。</span>':`<strong>${totalPending()?`${groups?groups+"个到访":"到访已逐项知悉"}${global?" · "+global+"项旅行条件待确认":""}`:"当前未知条件已逐项知悉"}</strong><span>知悉后仍是暂定，尚未核实的条件会保留。</span>`;
  if(conflictIds().length)$(".footer-copy").innerHTML='<strong>有到访时间重叠，需要先调整</strong><span>试排保留，明确冲突不能通过确认未知项跳过。</span>';
  $("#adopt-preview").textContent=state.adopted?"查看覆盖缺口":"审阅并采用";
  $(".trip-state").textContent=state.adopted?"暂定行程":"未采用草案";
  $('[data-panel="budget"]').textContent=`预算 CNY ${Number(state.budget).toLocaleString("zh-CN")}`;
}
const panelHeader=(title,subtitle)=>`<header class="inspector-heading"><div><h2 tabindex="-1">${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close-inspector" aria-label="关闭侧层" data-close>${icon("close")}</button></header>`;
function openPanel(kind){state.panel=kind;renderPanel();requestAnimationFrame(()=>$(".inspector h2")?.focus());save();}
function scopeBody(key){const info=globalInfo[key],id=`trip:${key}`;return `<section class="scope-detail"><h3>${info.title}</h3><p>${escape(key==="budget"?info.text.replace("CNY 9,000","CNY "+Number(state.budget).toLocaleString("zh-CN")):info.text)}</p>${key==="budget"&&!state.adopted?`<label class="journal-field">预算上限（CNY）<input id="budget-input" type="number" min="0" value="${Number(state.budget)}" style="padding:10px;border:1px solid #cfdbe4;border-radius:7px"><button class="panel-action" data-budget-save>保存预算上限</button></label>`:""}<label class="condition-row"><input type="checkbox" data-condition="${id}" ${known(id)?"checked":""} ${state.adopted?"disabled":""}><span>${info.ack}</span></label></section>`;}
function renderPanel(){
  const panel=$(".inspector");panel.hidden=!state.panel;if(!state.panel)return;
  if(state.panel.startsWith("time:")){
    const item=visit(state.panel.split(":")[1]),duration=toMinutes(item.timeEnd)-toMinutes(item.start);
    panel.innerHTML=panelHeader("调整这一次到访的时间",item.name+" · 12月5日 · 京都当地时间")+`<div class="inspector-scroll"><form id="time-form" data-time-visit="${item.id}" class="time-form"><label>当地开始时间<input type="time" required name="start" value="${item.start}"></label><label>停留分钟<input type="number" min="1" max="720" step="1" required name="duration" value="${duration}"></label><p>只更新这一处试排，不自动移动其他安排。发生时间重叠时，会保留冲突并阻止采用。</p><p id="time-error" role="alert"></p><button class="primary" type="submit">更新试排时间</button></form></div>`;
  } else if(state.panel.startsWith("compare:")){
    const id=state.panel.split(":")[1],item=visit(id);
    panel.innerHTML=panelHeader(state.adopted?"调整这一次到访":item.role==="fork"?"换一种午餐安排":"比较这一次到访",`12月5日 ${item.start}—${item.timeEnd} · 其余安排保持不变`)+`<div class="inspector-scroll"><p class="comparison-context">${escape(item.name)}是当前安排。对比位置、体验与未知条件后，再选择是否加入试排。</p>${alternatives[id].map(candidate=>`<article class="candidate"><small>${candidate.place===item.place?"当前安排":"比较对象"} · ${candidate.area}</small><h3>${candidate.name}</h3><p>${candidate.note}</p><dl><dt>位置参考</dt><dd>${(L.latLng(candidate.coordinate).distanceTo(referenceFor(id).coordinate)/1000).toFixed(1)} km · 与${escape(referenceFor(id).name)}的直线距离</dd><dt>预计占用</dt><dd>保留当前时间窗，衔接待核实</dd><dt>费用</dt><dd>尚未核实 · 原币种 JPY</dd><dt>同行人</dt><dd>步行与设施条件待核对</dd></dl><div class="candidate-actions"><button class="primary" data-candidate="${id}:${candidate.place}">${candidate.place===item.place?"保留此安排":state.adopted?"预览调整建议":"加入试排"}</button><button data-map-candidate="${id}:${candidate.place}">在地图上看</button></div></article>`).join("")}</div><div class="inspector-note">加入试排不会自动采用或预订。更换地点后，仅重新确认受影响的地点、费用、同行人与衔接条件。</div>`;
  } else if(state.panel==="review"){
    const pendingVisits=currentVisits().filter(item=>pendingFor(item)||conflictIds().includes(item.id));
    panel.innerHTML=panelHeader(state.adopted?"暂定行程的覆盖缺口":"采用前，把剩下的条件看清楚",state.adopted?"已保存的选择与未核实状态分别保留":"这里汇总未完成的审阅，确认仍在具体安排旁进行")+`<div class="inspector-scroll"><div class="review-summary">${state.adopted?"这份行程仍是<strong>暂定</strong>。地点、交通与费用条件没有因采用而变成已核验。":`还有 <strong>${totalPending()}项</strong>未知条件需要你逐项知悉。你可以回到对应安排继续，不必从头重来。`}</div>${(state.adopted?currentVisits():pendingVisits).map(item=>`<div class="pending-place"><span>${item.start} · ${item.name}<br><small>${state.adopted?"3项仍未核实":conflictIds().includes(item.id)?"时间重叠，需要先调整":pendingFor(item)+"项尚未确认"}</small></span><button data-return-visit="${item.id}">${state.adopted?"查看":"继续审阅"}</button></div>`).join("")}<div class="scope-choice">${globalKeys.map(key=>`<button data-panel="${key}">${globalInfo[key].title}<span>${state.adopted?"仍未核实":known("trip:"+key)?"已知悉":"待确认"}</span></button>`).join("")}</div>${state.adopted?"":`<div class="review-final">采用后仍持续显示覆盖缺口。目前只能按可用来源检查目的地天气；其他风险未覆盖，不会自动修改安排。<button class="primary" data-adopt ${totalPending()||conflictIds().length?"disabled":""}>采用暂定行程</button></div>`}</div>`;
  } else if(state.panel==="journal"){
    panel.innerHTML=panelHeader("照片手账","在这趟旅行里，留下一些自己的片段")+`<div class="inspector-scroll"><div class="journal-field"><label for="journal-note">第2天 · 京都</label><textarea id="journal-note" placeholder="写下想记住的一点……">${escape(state.journalDraft??state.journal)}</textarea><button class="primary" data-save-journal>保存示例手账</button></div><p class="readonly-notice">这份设计演示仅在本机保存示例文字，不上传照片，也不写入正式旅行。</p></div>`;
  } else {
    const key=globalKeys.includes(state.panel)?state.panel:"complete";
    panel.innerHTML=panelHeader(globalInfo[key].title,"这是整趟旅行的条件，不重复放进每个地点")+`<div class="inspector-scroll condition-panel">${scopeBody(key)}<div class="scope-choice">${globalKeys.filter(k=>k!==key).map(k=>`<button data-panel="${k}">${globalInfo[k].title}<span>${known("trip:"+k)?"已知悉":"待确认"}</span></button>`).join("")}</div><button class="panel-action" data-panel="review">返回采用审阅</button></div>`;
  }
}
let routeLayer, markers=new Map(), previewLayer;
function setupMap(){
  map=L.map("map",{zoomControl:false,scrollWheelZoom:false}).setView([35.0005,135.773],14);
  L.control.zoom({position:"topright"}).addTo(map);
  map.attributionControl.setPosition("bottomleft");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:17,minZoom:11,keepBuffer:0,updateWhenIdle:true,updateWhenZooming:false,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>'}).on("tileerror",()=>{if(++tileErrors>2)$(".map-failure").hidden=false;}).addTo(map);
  routeLayer=L.layerGroup().addTo(map); previewLayer=L.layerGroup().addTo(map);
  renderMap(true);
}
function renderMap(fit=false){
  if(!map)return;
  routeLayer.clearLayers();previewLayer.clearLayers();markers.clear();
  const items=state.day===2?currentVisits():[{id:"station",name:"京都站",coordinate:[34.9858,135.7588],type:state.day===1?"去程到达":"返程出发"}];
  if(items.length>1)L.polyline(items.map(item=>item.coordinate),{color:world==="lake"?"#166458":"#215ad7",weight:3,opacity:.85,dashArray:"5 8",smoothFactor:1}).addTo(routeLayer);
  items.forEach((item,index)=>{
    const selected=item.id===state.selected || items.length===1;
    const marker=L.marker(item.coordinate,{icon:L.divIcon({className:"route-pin"+(selected?" selected":""),html:String(index+1),iconSize:selected?[30,30]:[25,25],iconAnchor:selected?[15,15]:[12.5,12.5]}),keyboard:true,title:item.name}).addTo(routeLayer);
    const label=document.createElement("span");label.textContent=item.name;marker.bindTooltip(label,{permanent:true,direction:"top",offset:[0,-17]});
    marker.getElement()?.setAttribute("aria-label",`${index+1} ${item.name}`);
    marker.on("click",()=>{if(item.id!=="station")select(item.id,true,true);});markers.set(item.id,marker);
  });
  const item=state.day===2?visit(state.selected):items[0];
  $(".map-peek").innerHTML=`<span class="peek-label">${state.day===2?"第2天 · "+item.start:"你已记录的交通"}</span><strong>${escape(item.name)}</strong><p>${state.day===2?escape(item.note):"记录的时间和地点保持原样，衔接仍待核对。"}</p>${state.day===2?`<button data-return-visit="${item.id}">查看这一次到访 ${icon("arrow")}</button>`:""}`;
  if(fit)map.fitBounds(L.latLngBounds(items.map(item=>item.coordinate)),{padding:[65,80],maxZoom:14,animate:false});
}
function render(){renderDays();renderDay();renderFooter();renderPanel();$(".workspace").classList.toggle("mobile-map",state.mobileMap);renderMobileSwitch();}
function renderMobileSwitch(){let toggle=$(".mobile-switch");if(!toggle){toggle=document.createElement("div");toggle.className="mobile-switch";$(".workspace").append(toggle);}toggle.innerHTML=`<button data-mobile-mode="plan" class="${!state.mobileMap?"active":""}">行程</button><button data-mobile-mode="map" class="${state.mobileMap?"active":""}">地图</button>`;}
function select(id,expand=true,fromMap=false){state.day=2;state.selected=id;state.expanded=expand?id:null;if(!fromMap)state.panel=null;render();renderMap();save();if(!fromMap)map.panInside(visit(id).coordinate,{paddingTopLeft:[45,100],paddingBottomRight:[45,150]});if(!state.mobileMap)requestAnimationFrame(()=>$(`[data-visit="${id}"]`)?.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"nearest"}));}
document.addEventListener("click",event=>{
  const button=event.target.closest("button");if(!button)return;
  if(button.dataset.world){setWorld(button.dataset.world);renderMap();return;}
  if(button.id==="reset-demo"){localStorage.removeItem(storageKey);state=defaults();render();renderMap(true);toast("示例已重置，不影响正式旅行。");return;}
  if(button.dataset.day){state.day=Number(button.dataset.day);state.panel=null;state.mobileMap=false;render();renderMap(true);save();return;}
  if(button.dataset.select){select(button.dataset.select,state.expanded!==button.dataset.select);return;}
  if(button.dataset.toggle){state.expanded=state.expanded===button.dataset.toggle?null:button.dataset.toggle;renderDay();save();return;}
  if(button.dataset.time){openPanel("time:"+button.dataset.time);return;}
  if(button.dataset.compare){openPanel("compare:"+button.dataset.compare);return;}
  if(button.dataset.panel){openPanel(button.dataset.panel);return;}
  if(button.hasAttribute("data-close")){state.panel=null;renderPanel();previewLayer.clearLayers();save();return;}
  if(button.dataset.returnVisit){state.mobileMap=false;select(button.dataset.returnVisit,true);return;}
  if(button.dataset.mobileMode){state.mobileMap=button.dataset.mobileMode==="map";render();requestAnimationFrame(()=>{map.invalidateSize();if(state.mobileMap)renderMap(true);});return;}
  if(button.id==="fit-day"){renderMap(true);return;}
  if(button.id==="trip-conditions"||button.id==="adopt-preview"){openPanel("review");return;}
  if(button.dataset.mapCandidate){const [id,place]=button.dataset.mapCandidate.split(":");const candidate=alternatives[id].find(item=>item.place===place);if(innerWidth<=760){state.mobileMap=true;state.panel=null;render();map.invalidateSize();renderMap(true);}previewLayer.clearLayers();L.circleMarker(candidate.coordinate,{radius:12,color:world==="lake"?"#166458":"#215ad7",fillOpacity:.12,weight:2,dashArray:"4 4"}).addTo(previewLayer);map.panTo(candidate.coordinate,{animate:false});if(innerWidth>760)map.panBy([Math.min(190,map.getSize().x/3),0],{animate:false});$(".map-peek").innerHTML=`<span class="peek-label">比较对象 · 未加入试排</span><strong>${escape(candidate.name)}</strong><p>${escape(candidate.note)}</p><button data-compare="${id}">返回比较 ${icon("arrow")}</button>`;toast("地图中显示比较对象，不会改动当前安排。");return;}
  if(button.dataset.candidate){
    const [id,place]=button.dataset.candidate.split(":");if(visit(id).place===place){state.panel=null;renderPanel();return;}
    if(state.adopted){toast("采用版保持不变；这里仅预览调整，正式修改仍需重新核验。");return;}
    previous=structuredClone(state);const candidate=alternatives[id].find(item=>item.place===place);state.choices[id]=candidate;state.selected=id;state.expanded=id;state.panel=null;render();renderMap(true);save();toast("已加入示例试排。其他到访的确认保留；当前到访及相关衔接、预算与同行人条件需重确认。");return;
  }
  if(button.hasAttribute("data-budget-save")){const value=Number($("#budget-input").value);if(Number.isFinite(value)&&value>=0){state.budget=value;renderFooter();renderPanel();save();toast("示例预算已修改，只有受影响的预算确认失效。");}return;}
  if(button.hasAttribute("data-adopt")){if(!totalPending()&&!conflictIds().length){state.adopted=true;state.panel=null;render();save();toast("演示：暂定行程已采用，未核实条件仍然保留。正式服务未被调用。");}return;}
  if(button.hasAttribute("data-save-journal")){state.journal=$("#journal-note").value;state.journalDraft=null;save();toast("示例文字已保存在本机，不会上传。");}
});
document.addEventListener("submit",event=>{
  if(event.target.id!=="time-form")return;
  event.preventDefault(); const form=event.target,start=form.elements.start.value,duration=Number(form.elements.duration.value),end=toMinutes(start)+duration;
  if(!start||!Number.isInteger(duration)||duration<1||duration>720||end>=1440){$("#time-error").textContent="本次演示仅支持当天结束的到访，请调整开始时间或停留分钟。";return;}
  const endText=String(Math.floor(end/60)).padStart(2,"0")+":"+String(end%60).padStart(2,"0");
  state.times[form.dataset.timeVisit]={start,timeEnd:endText,duration:duration>=60?Math.floor(duration/60)+"小时"+(duration%60?duration%60+"分":""):duration+"分钟"};
  state.panel=null;state.selected=form.dataset.timeVisit;state.expanded=state.selected;render();save();toast(conflictIds().length?"时间已加入试排；存在重叠，需要先处理。":"试排时间已更新，只有受影响的确认失效。");
});
document.addEventListener("input",event=>{if(event.target.id==="journal-note"){state.journalDraft=event.target.value;save();}});
document.addEventListener("change",event=>{
  const id=event.target.dataset.condition;if(!id||state.adopted)return;
  if(event.target.checked)state.acknowledgments[id]=basis(id);else delete state.acknowledgments[id];
  save();renderFooter();renderDays();
  const article=event.target.closest("[data-visit]");
  if(article){const count=pendingFor(visit(article.dataset.visit)),badge=article.querySelector(".visit-badge"),conflict=conflictIds().includes(article.dataset.visit);badge.textContent=conflict?"时间有重叠":count?count+"项待确认":"已知悉 · 仍未核实";badge.classList.toggle("acknowledged",!count&&!conflict);}
  if(state.panel==="review")renderPanel();
});
$(".brand").addEventListener("click",event=>{event.preventDefault();state.day=2;state.panel=null;render();renderMap(true);});
$('[data-panel="journal"]').innerHTML=icon("camera");
setWorld(world);render();setupMap();
requestAnimationFrame(()=>$(`[data-visit="${state.selected}"]`)?.scrollIntoView({block:"nearest",behavior:"auto"}));
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&state.panel){state.panel=null;renderPanel();previewLayer.clearLayers();save();}});
window.addEventListener("resize",()=>map.invalidateSize());
