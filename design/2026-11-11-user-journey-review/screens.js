import './screens.css';
import L from 'leaflet';

// A local design prototype: scene navigation only, with no business writes or host messages.
const params = new URLSearchParams(location.search);
const isFrame = params.get('frame') === '1';
const stage = params.get('stage') || 'directions';
const route = ['a', 'b', 'c'].includes(params.get('route')) ? params.get('route') : 'a';
const day = Math.min(6, Math.max(1, Number(params.get('day')) || 2));
const after = params.get('after') === '1';
const resting = params.get('rest') === '1';
const adoptedPlan = params.get('adopted') === '1';
const acknowledged = Math.min(7, Math.max(0, Number(params.get('ack')) || 0));
const variant = params.get('variant') || 'practical';
const app = document.querySelector('#app');

const icon = (name, cls = '') => `<img class="icon ${cls}" src="./assets/icons/${name}.svg" alt="" aria-hidden="true">`;
const tag = (text, kind = 'neutral', name = '') => `<span class="tag ${kind}">${name ? icon(name) : ''}${text}</span>`;
const photo = (name, cls = 'photo') => `<img class="${cls}" src="./assets/${name === 'museum' ? 'kyoto-museum' : 'kiyomizu'}.jpg" alt="${name === 'museum' ? '京都国立博物馆建筑资料照片，2020年' : '清水寺秋季全景资料照片'}">`;
function href(next, values = {}) {
  const q = new URLSearchParams({ frame: '1', stage: next, route, day: String(day), after: after ? '1' : '0', rest: resting ? '1' : '0', adopted: adoptedPlan ? '1' : '0', ack: String(acknowledged), ...values });
  return `?${q}`;
}
const link = (next, text, cls = 'secondary', values = {}, name = '') => `<a class="${cls}" href="${href(next, values)}">${name ? icon(name) : ''}${text}</a>`;
const official = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}${icon('ArrowSquareOut')}</a>`;

const routes = {
  a: {
    title: '京都＋大阪，慢一点都玩到', short: '经典慢游', stay: '京都 3 晚 → 大阪 2 晚',
    description: '先看古都与秋色，再留两天给大阪街区。每天都留一段坐下来休息的时间。',
    move: '换 1 次酒店；跨城单程 1 次', burden: '不做跨城当天往返，节奏较均匀',
    tradeoff: '第 4 天需要带行李换酒店；少去一个远郊目的地。', price: '¥19,800–21,400',
    cities: ['京都', '京都', '京都', '大阪', '大阪', '大阪 → 上海'],
    themes: ['抵达，先安顿下来', '东山散步，下午回酒店', '岚山半日，留一段空白', '带行李去大阪，轻逛心斋桥', '大阪城公园与城市漫游', '收好行李，去机场'],
    night: ['京都·第 1 晚', '京都·第 2 晚', '京都·第 3 晚', '大阪·第 1 晚', '大阪·第 2 晚', '回到上海'],
    hotel: ['都酒店 京都八条', '都酒店 京都八条', '都酒店 京都八条', '大阪日航酒店', '大阪日航酒店', '无住宿'],
  },
  b: {
    title: '住在大阪，不搬行李', short: '大阪一地住宿', stay: '大阪 5 晚',
    description: '行李始终留在同一家酒店。大阪生活更从容，挑两天去京都看不同风景。',
    move: '不换酒店；京都往返 2 次', burden: '两天需要较早出门，增加 4 段跨城交通',
    tradeoff: '减少搬行李，但京都当天往返更费体力，回酒店休息较晚。', price: '¥18,600–20,000',
    cities: ['大阪', '京都 → 大阪', '大阪', '京都 → 大阪', '大阪', '大阪 → 上海'],
    themes: ['抵达大阪，住满五晚', '京都东山一日，傍晚回大阪', '大阪慢游，恢复体力', '岚山一日，原酒店续住', '城市漫游，收尾购物', '收好行李，去机场'],
    night: ['大阪·第 1 晚', '大阪·第 2 晚', '大阪·第 3 晚', '大阪·第 4 晚', '大阪·第 5 晚', '回到上海'],
    hotel: Array(5).fill('大阪日航酒店').concat('无住宿'),
  },
  c: {
    title: '住在京都，把古都住透', short: '京都深住', stay: '京都 5 晚',
    description: '清晨与夜晚都留在京都，分散安排东山、岚山和日常街区，只去大阪一天。',
    move: '不换酒店；大阪往返 1 次', burden: '京都日程更松，第 6 天赴机场路程更长',
    tradeoff: '大阪只留一天，没有大阪夜生活；返程要更早离开酒店。', price: '¥20,300–21,700',
    cities: ['京都', '京都', '京都', '大阪 → 京都', '京都', '京都 → 上海'],
    themes: ['抵达京都，住满五晚', '东山散步，下午回酒店', '岚山半日，留一段空白', '大阪一日，傍晚回京都', '京都街区，慢慢收尾', '提早出门，去机场'],
    night: ['京都·第 1 晚', '京都·第 2 晚', '京都·第 3 晚', '京都·第 4 晚', '京都·第 5 晚', '回到上海'],
    hotel: Array(5).fill('都酒店 京都八条').concat('无住宿'),
  },
};
const r = routes[route];
const stageInfo = {
  directions: ['01 选整趟方向', '先判断这趟旅行是否适合自己', '三条方向比较相同的问题。选中只展开每日试排，还没有采用、预订或付款。'],
  days: ['02 看每天安排', '看得懂一天，也知道哪里还没落实', '点日期切换；点到访联动地图。“换个安排”进入侧层，当前试排保留。'],
  compare: ['03 比较局部选择', '比较的是同一个上午的真实取舍', '体验、活动负担、时段、费用和未知条件相邻呈现。下一步先预览连带影响。'],
  impact: ['04 看连带影响', '把一次修改的代价放到台面上', '逐行对照时间和安排；固定晚餐与航班不动。确认只更新试排。还可查看失败和冲突稿。'],
  review: ['05 审阅并采用', '先看整趟旅行，再回到有疑问的安排', '在具体到访／交通段旁知悉未知条件。知悉不等于核实，全部处理后才能采用暂定行程。'],
  today: ['06 旅途中使用', '下一步和真正影响今天的变化优先', '这是一段合成的出行中情景。变化先形成建议；保留原行程，选择后再预览和确认。'],
};
Object.assign(stageInfo, {
  journal: ['07 照片手账', '从记录到重开，不依赖候选资料是否过期', '可新建纯文字或照片记录、关联日期／到访、编辑与排序、确认删除。界面复用正式组件，设计数据仅在内存中保存。'],
  relief: ['08 照片浮雕', '先比较效果，再决定是否保存', '本机建立照片层次；明确保存效果，源照片不变。未保存离开、保存失败与仅查看权限各有处理。'],
  immersion: ['09 目的地沉浸', '场景可探索，旅行事实仍有边界', '切换地点、章节、视角和导览；退出回到原位置。风格场景不作为实景、导航或已核验路线。'],
  share: ['10 共享授权', '先核对账号，再看清授权影响', '默认仅查看；编辑权限包含旅行记录与照片。新增、更改、撤销均明确确认，模拟账号不连接 Google。'],
});
const mediaFrames = {journal:'journal',relief:'relief',immersion:'destination',share:'share'};
const parentStage = ['weather-options', 'weather-impact', 'weather'].includes(stage) ? 'today' : ['condition', 'adopted'].includes(stage) ? 'review' : ['loading', 'unavailable', 'conflict'].includes(stage) ? 'impact' : stageInfo[stage] ? stage : 'days';

function header(mode = 'plan') {
  const step = stage === 'directions' ? 1 : ['review', 'condition', 'adopted'].includes(stage) ? 3 : 2;
  return `<div class="prototype-strip">交互设计稿 · 合成旅行案例 · 不保存、预订或发送消息</div><header class="product-header">
    <a class="product-brand" href="${href('directions')}">Travel<b> / </b>关西六日</a>
    ${stage === 'directions' ? `<div class="workflow" aria-label="规划步骤"><span class="${step === 1 ? 'active' : ''}"><i>1</i>选方向</span><span><i>2</i>调每天</span><span><i>3</i>采用行程</span></div>` : `<nav class="product-nav" aria-label="旅行"><a class="${mode === 'plan' ? 'active' : ''}" href="${href('days')}">行程</a><a class="${mode === 'today' ? 'active' : ''}" href="${href('today')}">Today</a><a class="${mode === 'journal' ? 'active' : ''}" href="${href('journal')}">手账</a><a class="${mode === 'more' ? 'active' : ''}" href="${href('more')}">更多</a></nav>`}
    <div class="header-right">${link('handoff', '回到对话', 'chat-link', {}, 'ArrowSquareOut')}${stage !== 'directions' ? link('share', '分享', 'secondary', {}, 'ShareNetwork') : ''}</div>
  </header>`;
}
function credits() {
  return `<footer class="credit-strip">地点资料图：清水寺 · lumoplank / CC0；京都国立博物馆 · Chainwit. / CC BY 4.0（2020）。${link('sources', '照片授权与资料来源', '')}</footer>`;
}
function footer(title, note, action, extra = '') {
  return `<div class="bottom-action"><div><strong>${title}</strong><p>${note}</p></div><div class="bottom-buttons">${extra}${action}</div></div>`;
}
const routeButton = (key, cls = 'secondary') => link('days', '选这条方向，展开 6 天', cls, { route: key, day: '1', after: '0', rest: '0', adopted: '0', ack: '0' }, 'ArrowRight');
function directionTable() {
  const rows = [
    ['住与移动', key => `<b>${routes[key].stay}</b><br><span class="quiet">${routes[key].move}</span>`],
    ['对长辈的影响', key => routes[key].burden],
    ['需要接受的取舍', key => routes[key].tradeoff],
    ['3 人总费用估算', key => `<div class="money">${routes[key].price}</div><span class="quiet small">人民币 · 不含尚未核实费用</span>`],
  ];
  return `<div class="route-comparison"><div class="route-grid"><div class="route-label head">旅行方向</div>${Object.entries(routes).map(([key, item]) => `<section class="route-cell head ${key === 'a' ? 'preferred' : ''}">${tag(key === 'a' ? '更适合这次同行人' : key === 'b' ? '少搬行李' : '更深入京都', key === 'a' ? 'suggested' : 'neutral')}<h3>${item.title}</h3><p>${item.description}</p></section>`).join('')}${rows.map(([label, get]) => `<div class="route-label">${label}</div>${Object.keys(routes).map(key => `<div class="route-cell ${key === 'a' ? 'preferred' : ''}">${get(key)}</div>`).join('')}`).join('')}<div class="route-label foot"></div>${Object.keys(routes).map(key => `<div class="route-cell foot ${key === 'a' ? 'preferred' : ''}">${routeButton(key, key === 'a' ? 'primary' : 'secondary')}</div>`).join('')}</div></div>
  <div class="route-mobile">${Object.entries(routes).map(([key, item]) => `<section class="${key === 'a' ? 'preferred' : ''}">${tag(key === 'a' ? '更适合这次同行人' : '另一种取舍', key === 'a' ? 'suggested' : 'neutral')}<h3>${item.title}</h3><p class="mobile-route-stay">${item.stay} · ${item.move}</p><div class="mobile-route-money"><b>${item.price}</b><span>3 人 / 人民币估算 · 尚有费用缺口</span></div><p class="mobile-route-tradeoff">${item.tradeoff}</p><details class="mobile-route-detail"><summary>看体验与体力取舍</summary><p>${item.description}</p><p>${item.burden}</p></details>${routeButton(key, key === 'a' ? 'primary' : 'secondary')}</section>`).join('')}</div>`;
}
function directionCards() {
  return `${variant === 'experience' ? `<div class="direction-photo">${photo('temple')}<span>京都东山 · 秋季旅行资料图</span></div>` : ''}<div class="alternate-directions">${Object.entries(routes).map(([key, item]) => `<section class="alternate-route"><div class="inside">${tag(key === 'a' ? '推荐方向' : key === 'b' ? '行李留在原处' : '住进古都日常', key === 'a' ? 'suggested' : 'neutral')}<h3>${item.title}</h3><p>${item.description}</p><hr class="rule"><p><b>${item.stay}</b><br>${item.move}</p><p>${item.burden}</p><p>${item.tradeoff}</p><div class="money">${item.price}<br><small class="quiet">3 人 / 人民币估算</small></div>${routeButton(key, key === 'a' ? 'primary' : 'secondary')}</div></section>`).join('')}</div>`;
}
function directions() {
  return `${header()}<main class="content direction-content"><div class="page-top"><div><h1>同样 6 天，哪种安排更适合你们？</h1><p>想看京都，也想逛大阪。差别主要在住哪里、搬几次行李，以及每天是否要跨城往返。</p></div>${link('requirements', '查看旅行要求', 'secondary', {}, 'ListChecks')}</div>
    <div class="trip-summary"><span>${icon('CalendarBlank')}11 月 20–25 日 · 上海往返</span><span>${icon('Users')}3 位成人，含一位长辈</span><span>${icon('PersonSimpleWalk')}少走长路，下午休息</span><span>总预算 ¥22,000 左右</span></div>
    <div class="recommendation">${icon('Heart')}<div><strong>更推荐：京都 3 晚＋大阪 2 晚</strong><p>只搬一次行李，换来少做两趟京都往返；两座城市都能慢慢逛，也更容易回酒店休息。</p></div></div>
    ${variant === 'practical' ? directionTable() : directionCards()}
    <div class="shared-anchors"><strong>${icon('Lock')}三条方向都保留</strong><span>去程 11/20　上海浦东 11:00 → 关西机场 14:20　${tag('你已记录', 'recorded')}</span><span>回程 11/25　关西机场 17:00 → 上海浦东 18:30　<span class="quiet">起降均为当地时间；日本比上海快 1 小时</span></span></div>
    <p class="design-footnote">估算范围：已记录往返机票、5 晚住宿建议（2 间 / 3 人）、基础交通与餐饮预留。门票、房间库存及部分接驳费用仍待核实；这里只选择方向，不代表费用已核验或完成预订。${link('budget', '看估算构成', '')}</p>
  </main>${credits()}`;
}
function dayNav() {
  return `<nav class="day-navigation" aria-label="选择日期">${r.cities.map((city, i) => `<a class="${day === i + 1 ? 'active' : ''}" ${day === i + 1 ? 'aria-current="date"' : ''} href="${href('days', { day: String(i + 1) })}"><strong>D${i + 1} · 11/${20 + i}</strong><small>${city}</small></a>`).join('')}</nav>`;
}
function tripBar() {
  return `<section class="trip-bar"><div><div class="trip-identity-line"><h1>${r.short} · 关西 6 日</h1>${tag(adoptedPlan ? '暂定行程' : '试排行程', adoptedPlan ? 'unknown' : 'suggested')}</div><p>${r.stay} · 3 位成人 · 11 月 20–25 日　${link('directions', '重看旅行方向', '')}</p></div><div class="trip-bar-right">${link('budget', '费用与预算', '', {}, 'Notebook')}${link('transport', '完整往返交通', '', {}, 'Train')}</div></section>${dayNav()}`;
}
function agendaItem(time, title, description, options = {}) {
  const selected = options.selected;
  return `<article class="agenda-item ${selected ? 'selected' : ''}" id="stop-${options.id || time.replace(':', '')}"><time class="agenda-time">${time}</time><span class="agenda-node" aria-hidden="true"></span><div class="agenda-card"><div class="${selected && options.image ? 'place-summary' : ''}">${selected && options.image ? photo(options.image) : ''}<div class="place-text"><header><h3>${options.select ? link('days', title, '', { stop: options.id }) : title}</h3>${options.status || ''}</header><p>${description}</p>${options.meta ? `<div class="agenda-meta">${options.meta}</div>` : ''}${options.actions ? `<div class="agenda-actions">${options.actions}</div>` : ''}</div></div></div></article>`;
}
const transfer = (text, values = {}) => `<div class="transfer">${icon('Train')}<span>${text}</span>${link('condition', '看交通条件', '', { condition: 'transfer', ...values })}</div>`;
function dayTwo() {
  const chosen = after ? 'museum' : 'temple';
  const stop = params.get('stop') || 'morning';
  const actions = `${link('compare', '换个安排', 'text-button', {}, 'ArrowsLeftRight').replace('<a ', '<a id="morning-choice" ')}${link('edit', '改时间', 'text-button', {}, 'Clock').replace('<a ', '<a id="morning-time" ')}${link('condition', after ? '看入场条件' : '看同行条件', 'text-button', { condition: after ? 'admission' : 'access' }, 'Info').replace('<a ', '<a id="morning-condition" ')}`;
  const isOsaka = route === 'b';
  return `${isOsaka ? agendaItem('07:00', '早餐后，从大阪去京都', '大阪日航酒店出发；需换乘跨城列车，具体班次与全程接驳尚未核实。', { status: tag('待核实交通', 'unknown'), actions: link('transport', '看当天往返', 'text-button') }) : agendaItem('07:30', '在酒店附近吃早餐', '自行安排，早餐后回房取随身物品。', { status: tag('自理', 'neutral') })}
    ${resting ? '' : !isOsaka ? transfer('08:45 从都酒店 京都八条出发 · 预留 45 分钟，具体接驳未核实', { condition: 'arrival' }) : transfer('大阪 → 京都 · 包含进出站与市内接驳，需重新核实', { condition: 'arrival' })}
    ${agendaItem('09:30', resting ? '在酒店慢慢休息' : after ? '京都国立博物馆' : '清水寺', resting ? '不再出门赶一个上午景点。早餐、休息后再前往午餐。' : after ? '室内特展为主，停留到 11:30。换掉户外上午，保留下午的祇园与休息。' : '从寺院眺望东山秋色，停留到 11:00。不再接第二个寺院，给长辈留余力。', { id: 'morning', selected: stop === 'morning', select: stop !== 'morning', image: resting ? '' : chosen, status: tag(resting ? '上午留白' : after ? '已换入试排' : '建议', after || resting ? 'saved' : 'suggested'), meta: resting ? '<span>不新增门票，下午时段保留</span>' : `<span>${after ? '3 人门票 ¥6,600 日元' : '门票待核实'}</span><span>${after ? '当日入场仍待确认' : '入口至寺院可用无障碍路线；接驳尚未核实'}</span>`, actions: resting ? link('compare', '重新比较上午安排', 'text-button') : actions })}
    ${transfer(resting ? '酒店 → 东山午餐 · 接驳需重新核实' : after ? '博物馆 → 东山午餐 · 预留 30 分钟，车行方案仍待核实' : '清水寺 → 东山午餐 · 预留 30 分钟，沿途步行负担待核实')}
    ${agendaItem(after ? '12:00' : '11:30', '东山午餐', '留 1 小时吃饭；按你们的要求自行选择餐厅，未作餐厅预约。', { id: 'lunch', selected: stop === 'lunch', select: stop !== 'lunch', status: tag('自理', 'neutral'), actions: link('handoff', '请助手推荐餐厅', 'text-button', { topic: 'lunch' }) })}
    ${agendaItem(after ? '13:30' : '13:00', '祇园短逛', '只安排一段街区散步，累了可以提早结束，不追加景点。', { id: 'gion', selected: stop === 'gion', select: stop !== 'gion', status: tag('建议', 'suggested'), meta: '<span>停留 1 小时 · 步行负担为估算</span>', actions: link('handoff', '请助手调整', 'text-button', { topic: 'gion' }) })}
    ${agendaItem(isOsaka ? '16:00' : after ? '15:15' : '14:45', '回酒店休息', isOsaka ? '先返回大阪，预计 16:00 回酒店；跨城接驳未核实，休息时间更短。' : '在房间休息至 16:30，留出晚餐前的整段空白。', { id: 'hotel', selected: stop === 'hotel', select: stop !== 'hotel', status: tag('保留休息', 'saved') })}
    ${agendaItem('17:30', '晚餐时间保留', '你固定的晚餐时段，自行安排。不因上午换地点而移动。', { status: tag('你已固定', 'recorded', 'Lock') })}`;
}
function otherDay() {
  const items = day === 1 ? [
    ['11:00', '上海浦东出发', '你记录的往返机票：11:00 上海出发，14:20 抵达关西。飞行约 2 小时 20 分钟，抵达时间为日本当地时间。', tag('你已记录', 'recorded', 'Airplane')],
    ['14:20', '抵达关西机场', '预留入境和提取行李时间；不紧接固定门票活动。', tag('保留缓冲')],
    ['16:00', route === 'b' ? '从机场前往大阪酒店' : '从机场前往京都酒店', '接驳方式建议优先少换乘；具体班次、行李条件、可用票价尚未核实。', tag('待核实交通', 'unknown')],
    ['17:30', '办理入住，先休息', `${r.hotel[0]} · 建议选择，尚未预订；需核实 2 间房及 3 位成人入住条件。`, tag('住宿建议', 'suggested')],
    ['19:00', '酒店附近晚餐', '自行安排，以容易返回酒店为优先，今天不安排夜游。', tag('自理')],
  ] : day === 6 ? [
    ['08:00', '早餐与收拾行李', '核对证件、充电器与随身物品；行李寄存条件需向酒店确认。', tag('准备离开')],
    [route === 'c' ? '10:30' : '12:00', '退房，带行李前往机场', route === 'c' ? '京都出发，较大阪住宿方向更早离开；交通预留尚需用具体班次核实。' : '大阪出发，预留机场办理手续时间；具体接驳与行李条件尚未核实。', tag('待核实交通', 'unknown')],
    ['14:00', '抵达关西机场，办理手续', '目标抵达时间为安排预留，需根据实际航班及机场要求复核。', tag('时间预留')],
    ['17:00', '关西机场起飞', '保留已记录航班：17:00 日本起飞，18:30 上海落地，约 2 小时 30 分钟。', tag('你已记录', 'recorded', 'Lock')],
    ['18:30', '回到上海', '当地时间；返家交通自行安排。', tag('当地时间')],
  ] : day === 3 && route !== 'b' || day === 4 && route === 'b' ? [
    ['08:00', '早餐后再出门', '不安排清晨赶车，午前只去一个区域。', tag('自理')],
    ['09:30', '岚山半日', '以河岸与街区为主，是否加入庭园参观到现场再决定；额外门票未计入。', tag('建议', 'suggested')],
    ['12:00', '岚山午餐', '自行选择餐厅，保留足够座席休息时间。', tag('自理')],
    ['14:30', route === 'b' ? '从京都返回大阪' : '回京都酒店休息', '今天的主要活动到这里结束，交通班次与接驳仍需核实。', tag('保留休息', 'saved')],
    ['17:30', '晚餐', '自行安排，不追加跨区域晚间活动。', tag('自理')],
  ] : [
    ['08:00', '早餐，慢慢出发', '自行安排，留足出门准备时间。', tag('自理')],
    ['10:00', day === 4 && route === 'a' ? '退房，带行李去大阪' : r.cities[day - 1].startsWith('京都') ? '京都街区散步' : '大阪城公园与街区', day === 4 && route === 'a' ? '当日只搬一次酒店；京都退房、大阪寄存与房间准备时间仍需确认。' : '只安排一个主要片区；不把远离的景点塞进同一天。', tag('建议', 'suggested')],
    ['12:00', '午餐与休息', '自行选择餐厅，给长辈留出坐下来的时间。', tag('自理')],
    ['14:30', day === 4 && route === 'a' ? '大阪日航酒店办理入住' : '回原酒店休息', `${r.hotel[day - 1]} · 建议已选，尚未预订；房间库存未核实。`, tag('住宿建议', 'suggested')],
    ['17:30', '晚餐与轻松收尾', '自行安排；跨城日还需预留返程交通，不追加夜间远途。', tag('自理')],
  ];
  return items.map(([time, title, text, status], index) => agendaItem(time, title, text, { id: String(index), status, actions: status.includes('待核实交通') ? link('transport', '看交通依据', 'text-button') : '' })).join('');
}
function mapStops() {
  const hotel = route === 'b' || (route === 'a' && day >= 4) ? [34.6755, 135.5007, 'hotel', 'H', '大阪日航酒店'] : [34.9830, 135.7567, 'hotel', 'H', '都酒店 京都八条'];
  if (day === 1 || day === 6) return [[34.4344, 135.2441, 'airport', 'KIX', '关西机场'], hotel];
  if (day !== 2) return [[35.0116, 135.7681, 'city', '京', '京都市位置参考'], [34.6937, 135.5023, 'city', '阪', '大阪市位置参考']];
  return [route === 'b' ? [34.9858, 135.7588, 'transfer', '站', '京都站接驳'] : hotel, ...(resting ? [] : [[after ? 34.9896 : 34.9949, after ? 135.7730 : 135.7850, 'morning', '1', after ? '京都国立博物馆' : '清水寺']]), [35.0036, 135.7783, 'gion', '2', '祇园街区']];
}
function mapShell() {
  return `<div class="map-shell" id="day-map"><div class="map-box" id="trip-map" aria-label="${day === 2 ? '京都当日地点位置' : '关西旅行地点位置'}"></div><div class="map-label">${day === 2 ? '京都 · 当天地点' : '关西 · 位置参考'}</div></div><p class="map-note">点地图标记定位到访；连线仅表示到访顺序，不是导航路线。交通时间另行核实。</p>`;
}
function stay() {
  return `<section class="side-section stay-summary"><h3>${icon('Bed')}今晚住哪里</h3><p>${r.hotel[day - 1]}</p><p>${tag(day === 6 ? '无需住宿' : '建议已选，未预订', 'suggested')}</p><p class="eyeless-meta">${day === 6 ? '回到上海，结束旅行。' : `${r.night[day - 1]} · 2 间房 / 3 位成人<br>房型、含餐与库存仍待核实。`}</p><div class="side-actions">${link('stay', '看住宿选择', '')}${link('handoff', '请助手换一家', '', { topic: 'stay' })}</div></section>`;
}
function relevantConditions() {
  if (day !== 2) return `<section class="side-section"><h3>${icon('ListChecks')}这一天还需落实</h3><a class="unresolved-link" href="${href('transport')}">${icon('Train')}<span><strong>${day === 1 ? '机场至酒店的完整接驳' : day === 6 ? '赴机场与返家接驳' : '当天交通与住宿衔接'}</strong><small>具体班次、行李、票价和步行负担尚未核实</small></span>${icon('CaretRight', 'caret')}</a>${day !== 6 ? `<a class="unresolved-link" href="${href('stay')}">${icon('Bed')}<span><strong>房间仍是建议选择，尚未预订</strong><small>2 间房 / 3 人入住条件与库存需确认</small></span>${icon('CaretRight', 'caret')}</a>` : ''}${link('prepare', '整趟准备事项', 'text-button')}</section>`;
  return `<section class="side-section"><h3>${icon('ListChecks')}和这一天有关</h3>${!resting ? `<a class="unresolved-link" href="${href('condition', { condition: after ? 'admission' : 'access' })}">${icon('Info')}<span><strong>${after ? '博物馆入场条件尚未落实' : '长辈到达入口的方式需核实'}</strong><small>${after ? '展期与票价有官方依据；当天入场仍未知' : '寺院有无障碍路线；酒店至入口接驳未知'}</small></span>${icon('CaretRight', 'caret')}</a>` : ''}<a class="unresolved-link" href="${href('condition', { condition: 'transfer' })}">${icon('Train')}<span><strong>午餐前接驳还需确认</strong><small>${after || resting ? '更换上午安排后，需要重新确认这一段' : '时长预留不能代替实际路线'}</small></span>${icon('CaretRight', 'caret')}</a>${link('prepare', '整趟准备事项', 'text-button', {}, 'Notebook')}</section>`;
}
function daily() {
  const rationale = day === 1 ? '今天只有抵达、入住与附近晚餐。把入境、行李和接驳算进去，不用第一天赶景点。' : day === 6 ? '先确保完整返程，保留机场办理手续的时间，不在出发前追加远处景点。' : day === 2 ? route === 'b' ? '今天用不搬行李换取两段跨城交通；下午回酒店会较晚。若体力不合适，可重看京都＋大阪的住宿方向。' : '上午一个主要安排，下午短逛后回酒店。餐饮自理，11 月 21 日 17:30 的晚餐时间保留。' : day === 4 && route === 'a' ? '换酒店的这一天只做轻松城市活动，行李处理与入住不夹在两个紧凑景点之间。' : '只安排一个主要片区，保留午餐和下午休息。今天不追加远距离往返。';
  const changed = day === 2 && (after || resting);
  return `${header()}${tripBar()}<main class="daily-content"><section class="day-main">${changed ? `<div class="saved-notice">${icon('CheckCircle')}<div><strong>${resting ? '上午已改为酒店休息' : '这 4 处试排已一起更新'}</strong><p>${resting ? '取消上午到访，下午与固定晚餐保留。' : '换入博物馆；午餐、祇园、休息各后移 30 分钟。固定晚餐不变。'}${link('impact', '重看这次变化', '', { choice: resting ? 'rest' : 'museum' })}</p></div></div>` : ''}<div class="day-title"><div><h2>${r.themes[day - 1]}</h2><p>11 月 ${19 + day} 日 · ${r.cities[day - 1]} · 日本当地时间</p></div>${link('map', '地图', 'mobile-map-link', {}, 'MapPin')}${link('handoff', '和助手调整这一天', 'secondary', {}, 'ArrowSquareOut')}</div><p class="day-rationale">${icon('PersonSimpleWalk')}${rationale}</p><div class="agenda">${day === 2 ? dayTwo() : otherDay()}</div></section><aside class="daily-side">${mapShell()}${stay()}${relevantConditions()}</aside></main>${footer(adoptedPlan ? '暂定安排仍有条件待落实' : '当前是试排，可以继续改', adoptedPlan ? '可以继续查看缺口；新调整仍需预览与确认。' : '采用前再统一审阅整趟安排与未落实条件。', link('review', adoptedPlan ? '查看整趟与未落实条件' : '审阅整趟并采用', 'primary', {}, 'ArrowRight'), link('handoff', '回到对话'))}${credits()}`;
}
function closeLayer(title) {
  return `<header class="layer-header"><div><span>设计稿 · 合成情景　/　11 月 21 日 · 京都上午</span><strong>${title}</strong></div><a class="icon-button" aria-label="关闭侧层，返回当天安排" href="${href('days', { day: '2', focus: stage === 'condition' ? 'condition' : stage === 'edit' ? 'time' : 'choice' })}">${icon('X')}</a></header>`;
}
function layer(contents, title, bottom) {
  return `<div class="layer-underlay" inert aria-hidden="true">${daily()}</div><div class="layer-shade"></div><aside class="decision-drawer" role="dialog" aria-modal="true" aria-labelledby="layer-title">${closeLayer(title)}${contents}${bottom || ''}</aside>`;
}
function compare() {
  const cards = [
    { title: '保留清水寺', kind: '当前试排', image: 'temple', desc: '东山秋色与寺院景观。这是原来最想看的画面，但仍有户外与到达入口的负担。', experience: '寺院与秋色，户外为主', effort: '寺内有无障碍路线；酒店至入口接驳未核实', time: '09:30–11:00；后续时间不变', cost: '门票与接驳费尚未核实', unknown: '同行人能否接受到达方式与当天负担', button: link('days', '保留当前安排', 'secondary', { day: '2' }) },
    { title: '京都国立博物馆', kind: '更适合想减少户外的上午', image: 'museum', desc: '换成室内特展，不在这一上午另加寺院。展期覆盖 11 月 21 日，但当天能否入场仍需落实。', experience: '历史与艺术，室内为主', effort: '减少户外停留；馆内步行量及接驳仍需核实', time: '09:30–11:30；后面 3 项需顺延', cost: '门票 ¥6,600 日元 / 3 成人；接驳另估', unknown: '当天可入场性、实际票务要求与到达方案', button: link('impact', '预览换成博物馆', 'primary', { choice: 'museum' }, 'ArrowRight') },
    { title: '把上午留给休息', kind: '把体力留给下午', desc: '不换成另一处景点。在酒店慢慢吃早餐、休息，午餐后再去祇园。', experience: '少一个景点，保留更多休息', effort: '减少一次上午出门；不产生新门票', time: '上午空出来，下午时段保留', cost: '减少的旧门票／交通费尚不能算定', unknown: '需重新核实酒店至午餐地点的接驳', button: link('impact', '预览改为休息', 'secondary', { choice: 'rest' }, 'ArrowRight') },
  ];
  return layer(`<main class="content comparison-page"><div class="comparison-top"><div><h1 id="layer-title">上午换得轻松一些，怎么选？</h1><p>比较的是同一个上午。17:30 的固定晚餐和已记录的往返航班都保留。</p></div></div><div class="mobile-current-choice">当前：清水寺 · 09:30–11:00</div><div class="candidate-tabs" aria-label="比较上午候选">${cards.map((c, i) => `<button data-candidate="${i}" aria-pressed="${i === 1}">${['清水寺', '博物馆', '酒店休息'][i]}</button>`).join('')}</div><div class="compare-cards">${cards.map((c, i) => `<article data-choice="${i}" class="choice-card ${i === 1 ? 'recommended mobile-selected' : ''}">${c.image ? photo(c.image, 'choice-visual') : `<div class="rest-visual">${icon('Moon')}<strong>上午留白</strong><span>不为换地点再赶一处景点</span></div>`}<div class="choice-content">${tag(c.kind, i === 1 ? 'suggested' : 'neutral')}<h3>${c.title}</h3><p class="choice-description">${c.desc}</p><dl class="choice-dl">${[['体验', c.experience], ['活动负担', c.effort], ['时间', c.time], ['费用', c.cost], ['未落实', c.unknown]].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>${c.button}${i === 1 ? `<a class="source-link" href="${href('sources')}">馆方展期、开放与票价依据</a>` : ''}</div></article>`).join('')}</div><div class="comparison-context">${icon('Info')}<span>这里先选方向，不会立即改动行程。下一步会逐行展示时间与费用影响，确认后才更新试排。</span></div></main>`, '比较上午安排', `<div class="bottom-action mobile-comparison-footer"><div><strong>先看这次选择的影响</strong><p>当前试排不变，下一步预览。</p></div><div id="mobile-candidate-action">${cards[1].button}</div></div>`);
}
function impact() {
  const rest = params.get('choice') === 'rest';
  const rows = rest ? [
    ['上午安排', '清水寺<br>09:30–11:00', '酒店休息<br>09:30–11:00', '换成休息，不再增加景点'],
    ['午餐', '11:30–12:30', '11:30–12:30', '原时段保留', true],
    ['祇园短逛', '13:00–14:00', '13:00–14:00', '原时段保留', true],
  ] : [
    ['上午到访', '清水寺<br>09:30–11:00', '京都国立博物馆<br>09:30–11:30', '室内特展，停留多 30 分钟'],
    ['东山午餐', '11:30–12:30', '12:00–13:00', '为新地点与接驳留出时间'],
    ['祇园短逛', '13:00–14:00', '13:30–14:30', '保留 1 小时，不压缩参观'],
    ['酒店休息', '14:45–16:30', '15:15–16:30', '休息由 1 小时 45 分缩短为 1 小时 15 分'],
  ];
  rows.push(['晚餐', '17:30', '17:30', '你固定的时段，保持不动', true]);
  return layer(`<main class="content comparison-page"><div class="comparison-top"><div><h1 id="layer-title">${rest ? '上午留白，下午照常' : '换成博物馆，这一天会怎样？'}</h1><p>${rest ? '减少一个上午到访，保留午餐、祇园与固定晚餐。' : '午餐和下午顺延 30 分钟，休息少 30 分钟；固定晚餐不动。新增门票 ¥6,600 日元，整趟净差额仍未知。'}</p></div></div><div class="impact-layout"><section><table class="impact-table"><caption class="sr-only">本次连带调整前后对照</caption><thead><tr><th>安排</th><th>现在的试排</th><th>准备更新为</th></tr></thead><tbody>${rows.map(([name, before, next, reason, same]) => `<tr class="${same ? 'unchanged' : ''}"><td>${name}${same ? `<br>${tag('保持不变', 'saved', 'Lock')}` : ''}</td><td>${before}</td><td>${next}<small>${reason}</small></td></tr>`).join('')}</tbody></table><p class="small quiet" style="margin-top:14px">${icon('Lock')} 11/20 去程、11/25 回程航班与其余 5 天不受这次改动影响。</p></section><aside class="impact-aside"><h3>费用能算清多少？</h3><div class="cost-lines">${rest ? `<div><span>新增门票</span><b>无</b></div><div><span>酒店 → 午餐接驳</span><b>待核实</b></div>` : `<div><span>新门票 · 3 位成人</span><b>¥6,600 日元</b></div><div><span>示例交通预留增加</span><b>约 ¥1,800 日元</b></div><div><span>扣除原清水寺费用</span><b>原费用未核实</b></div>`}<div><span>整趟净增／净减</span><b>暂不能算定</b></div></div><p class="small">${rest ? '原清水寺门票和交通费用未核实，不能把它们当作确定节省。' : '门票依据为馆方当前特展票价；交通为设计情景估算。原门票与接驳费用缺失，不能报告一个准确差额。'}</p><div class="practical-note"><strong>哪些条件需要重新看？</strong>${rest ? '不再使用清水寺到达条件；改看酒店至午餐的接驳。其他依据未变的知悉记录保留。' : '博物馆当天入场、酒店至博物馆与午餐前接驳需要确认；午餐及休息依然在你允许的时段内。依据未变的其余知悉记录保留。'}</div><div class="impact-note-links">${link('sources', '看费用与开放依据', '')}${link('condition', '看未落实条件', '', { condition: 'admission' })}</div></aside></div></main>`, '预览连带影响', footer('只更新试排，采用版保持原样', '待采用前，会再次审阅剩余未知条件。', link(rest ? 'days' : 'days', rest ? '更新这 1 处试排' : '更新这 4 处试排', 'primary', { day: '2', after: rest ? '0' : '1', rest: rest ? '1' : '0', ack: '0' }, 'Check'), link('compare', '返回比较')));
}
function checkState(kind) {
  const data = {
    loading: ['正在核对这次调整', '正在检查入场时段与前后接驳。当前试排保持原样，核对完成后再预览。', '核对中', '预览完成的画面', 'impact'],
    unavailable: ['这段交通暂时查不到', '已保留你选的博物馆，但目前无法核实到午餐的接驳。原试排没有改变，可以只重查这一段或回去比较。', '来源暂不可用', '重查这一段', 'loading'],
    conflict: ['这个时间会挤到固定晚餐', '若将博物馆移到 14:30，原休息和 17:30 晚餐无法同时保留。这不是待知悉条件，当前组合不能直接更新。', '与固定项冲突', '改回上午方案', 'impact'],
  }[kind];
  return layer(`<main class="content"><section class="state-panel"><h1 id="layer-title">${data[0]}</h1><p>${data[1]}</p>${kind === 'loading' ? '<div class="loading-lines" aria-label="检查中的信息占位"><span></span><span></span><span></span></div>' : ''}<div class="inline-facts"><span>${tag(data[2], kind === 'conflict' ? 'blocked' : 'unknown')}</span><span>${icon('Lock')}固定晚餐 17:30 不动</span></div><div class="form-buttons">${link(data[4], data[3], 'primary')}${link('compare', '返回比较', 'secondary')}</div></section></main>`, '检查调整条件');
}
function summaryRows() {
  return r.themes.map((theme, i) => `<div class="summary-day"><time>11/${20 + i}<br>D${i + 1}</time><div><strong>${i === 1 && after ? '博物馆、祇园与酒店休息' : theme}</strong><small>${r.cities[i]} · ${r.night[i]}${i === 1 ? ' · 17:30 晚餐固定' : ''}</small></div></div>`).join('');
}
function review() {
  const ready = resting ? (acknowledged & 2) === 2 : acknowledged === 7;
  const admissionDone = (acknowledged & 1) === 1;
  const transferDone = (acknowledged & 2) === 2;
  const arrivalDone = (acknowledged & 4) === 4;
  return `${header()}<main class="content comparison-page"><a class="back-link" href="${href('days')}">${icon('ArrowLeft')}返回试排行程</a><div class="page-top"><div><h1>${adoptedPlan ? '查看目前采用的暂定行程' : '把这份安排，作为接下来的行程'}</h1><p>先看整趟，再处理还没落实的条件。知悉未知不代表条件已满足，采用后会继续标为暂定。</p></div>${tag(adoptedPlan ? '已采用 · 暂定' : '尚未采用', adoptedPlan ? 'unknown' : 'suggested')}</div><div class="review-layout"><section><div class="adoption-overview"><header><h3>${r.short} · 11 月 20–25 日</h3><p class="small quiet">3 位成人 · ${r.stay} · 上海往返</p></header>${summaryRows()}</div><div class="receipt-details"><dl><dt>往返交通</dt><dd>保留你记录的两段航班；机场与跨城接驳尚有缺口</dd><dt>住宿选择</dt><dd>${r.stay}，2 间房 / 3 人；已选建议，未完成预订</dd><dt>费用范围</dt><dd>${r.price} 人民币估算${after ? '，本次调整净差额未算定' : ''}；部分门票、接驳及库存费用未核实</dd></dl></div></section><section class="review-unfinished"><h3>${ready ? '已记录你的逐项知悉' : '还有条件需要回到安排旁看清'}</h3><p>只重新处理本次换入内容及实际受影响的接驳。其余依据未变的记录继续保留。</p>${!admissionDone && !resting ? `<article class="review-item">${tag(`11/21 · 09:30 · ${after ? '博物馆' : '清水寺'}`, 'unknown')}<h4>${after ? '当天是否能入场，还没有落实' : '从酒店到入口的到达方式尚未落实'}</h4><p>${after ? '官方展期覆盖这一天，但没有取得当日票务可用性与入场条件。' : '寺内有无障碍路线，但整段接驳与沿途步行负担仍需核实。'}</p>${link('condition', '回到这次到访，逐项知悉', 'text-button', { condition: after ? 'admission' : 'access' }, 'CaretRight')}</article>` : ''}${!arrivalDone && !resting ? `<article class="review-item">${tag('11/21 · 08:45 · 酒店出发', 'unknown')}<h4>酒店至${after ? '博物馆' : '清水寺'}的到达方式尚未核实</h4><p>需要核实全程耗时、上下客点与长辈的步行负担；地点换了，旧接驳依据不能继续使用。</p>${link('condition', '回到出发这段，逐项知悉', 'text-button', { condition: 'arrival' }, 'CaretRight')}</article>` : ''}${!transferDone ? `<article class="review-item">${tag(`11/21 · ${after ? '11:30–12:00' : '11:00–11:30'} · 接驳`, 'unknown')}<h4>${resting ? '酒店' : after ? '博物馆' : '清水寺'}到午餐的路线尚未核实</h4><p>预留 30 分钟不等于已有可行交通；需核实 3 位同行人的到达负担。</p>${link('condition', '回到这段交通，逐项知悉', 'text-button', { condition: 'transfer' }, 'CaretRight')}</article>` : `<div class="saved-notice">${icon('CheckCircle')}<div><strong>${ready ? '所需未知条件均已知悉，仍未核实' : '交通条件已知悉，其他项仍需处理'}</strong><p>采用后继续保留缺口标记。若入场或接驳依据改变，只重看受影响的项。</p></div></div>`}<details class="saved-review"><summary>其他已知悉项仍保留 · 仍有事实待核实</summary><ul><li>住宿 2 间房、3 位成人入住条件</li><li>机场接驳、跨城交通与行李条件</li><li>其余到访及自行安排餐饮的费用缺口</li></ul></details><section class="follow-review"><h3>采用后启用：执行风险跟进</h3><p>当前覆盖天气；航班状态、场所开放与预约尚未覆盖。旅行结束后 24 小时停止。</p>${tag('天气可检查', 'saved')}${tag('航班未覆盖', 'unknown')}${tag('场所变化未覆盖', 'unknown')}${link('coverage', '看覆盖详情', 'text-button')}</section><div class="adoption-decision">将保存为<strong>暂定行程</strong>。酒店、门票尚未预订；无付款或自动退改。你仍可继续调整，未落实条件会一直显示。</div></section></div></main>${footer(ready ? '将采用为暂定行程' : '先处理与具体安排有关的未知条件', ready ? '知悉记录保留，未知事实继续标注。' : '这一步不会把未知条件变成已核验。', ready ? (adoptedPlan ? link('days', '返回每日行程', 'primary') : link('adopted', '采用暂定行程', 'primary', { adopted: '1' }, 'Check')) : `<button class="primary" disabled>采用暂定行程</button>`, !ready ? link('condition', '继续逐项知悉', 'secondary', { condition: !admissionDone && !resting ? (after ? 'admission' : 'access') : !arrivalDone && !resting ? 'arrival' : 'transfer' }) : link('days', '继续修改'))}${credits()}`;
}
function condition() {
  const kind = params.get('condition') || 'admission';
  const isTransfer = kind === 'transfer';
  const arrival = kind === 'arrival';
  const transport = isTransfer || arrival;
  const access = kind === 'access';
  const done = (acknowledged & (isTransfer ? 2 : arrival ? 4 : 1)) !== 0;
  return layer(`<main class="content comparison-page"><a class="back-link" href="${href('review', {})}">${icon('ArrowLeft')}整趟采用审阅</a><div class="page-top"><div><h1 id="layer-title">${arrival ? `从酒店到${after ? '博物馆' : '清水寺'}` : isTransfer ? `从${resting ? '酒店' : after ? '博物馆' : '清水寺'}到东山午餐` : access ? '到清水寺，长辈怎么走？' : '京都国立博物馆 · 当天入场'}</h1><p>${arrival ? '11 月 21 日 · 08:45 出发，09:30 到访' : isTransfer ? `11 月 21 日 · ${after ? '11:30 出发，12:00' : '11:00 出发，11:30'} 午餐` : '11 月 21 日 · 09:30 到访'}　${tag('仍有条件未核实', 'unknown')}</p></div></div><section class="condition-sheet"><div class="condition-context">${transport ? icon('Train') : photo(access ? 'temple' : 'museum')}<div><h3>${arrival ? '出门至入口，整段都要核实' : isTransfer ? '预留 30 分钟，不代表路线已可行' : access ? '寺内通行与酒店接驳分开看' : '展期有依据，票务可用性没有'}</h3><p>${arrival ? '3 位成人同行，含长辈。出发时间只是预留，具体上下客点、步行与路况没有核实。' : isTransfer ? '3 位成人同行，含长辈。前一项 11:30 结束；午餐安排为自理，无已预约餐厅。' : access ? '官方提供无障碍参拜路线；酒店至入口的道路、上下客点与当日交通需要另行核实。' : '室内特展替换了原上午清水寺，停留 2 小时；不会移动 17:30 固定晚餐。'}</p></div></div><div class="condition-fact">${icon('CheckCircle')}<div><strong>${transport ? '已保留前后安排与时间预留' : access ? '官方说明有无障碍参拜路线' : '官方展期覆盖 11 月 21 日'}</strong><p>${arrival ? `酒店 08:45 出发，${after ? '博物馆' : '清水寺'} 09:30 到访。换地点后重新看这段接驳。` : isTransfer ? `${resting ? '上午留在酒店，' : after ? '博物馆 09:30–11:30，' : '清水寺 09:30–11:00，'}午餐 ${after ? '12:00–13:00' : '11:30–12:30'}。这里尚没有可用于出行的路线、班次或实时道路结果。` : access ? '不能据此推断整段酒店至寺院的行程没有步行负担。' : '特展 2026/10/6–11/29；通常 09:00–17:30、17:00 截止入场。成人 ¥2,200 日元，3 人 ¥6,600 日元。'}</p></div></div><div class="condition-unknown"><strong>${transport ? '未知：实际路线、耗时与同行负担' : access ? '未知：从酒店到入口的实际到达条件' : '未知：当天可入场性与票务要求'}</strong><p>${arrival ? '未取得酒店至到访地点的实际路线、耗时和报价。如果不能按时到达，上午及后续安排可能需要调整。' : isTransfer ? '未取得这段接驳的真实路线和报价。如果实际需要更长时间，午餐、祇园与休息可能再次顺延。' : access ? '尚未核实车辆能否到达适合的入口、沿途坡度与实际步行量。寺内有无障碍路线不等于同行人全程都能轻松到达。' : '没有取得 11 月 21 日的票务可用性、必要预约及当日限制。若无法入场，上午安排需要重新选择。'}</p><label class="acknowledgment"><input id="condition-ack" type="checkbox" ${done ? 'checked' : ''}><span>${transport ? '我知道这段接驳尚未核实，愿意在暂定行程中保留，并在出行前落实。' : access ? '我知道到达入口的条件尚未核实，愿意在暂定行程中保留，并在出行前落实。' : '我知道当天入场仍未落实，愿意在暂定行程中保留，并在出行前落实。'}</span></label></div><p class="condition-feedback" id="condition-feedback">${done ? '已知悉，事实仍未核实。这项记录在依据改变时需要重新确认。' : '勾选只表示知悉这一项未知条件，不表示已买票、已核实或保证可行。'}</p><div class="condition-links">${link('sources', '看官方资料与检查范围', '')}${link('compare', '换一个安排', '')}${link('handoff', '请助手继续核实', '', { topic: transport ? 'transfer' : 'admission' })}</div></section></main>`, '具体安排旁的条件确认', footer('逐项记录在同一趟旅行', '回到同一旅行继续；依据未变的记录保留。', `<a id="condition-continue" class="primary ${done ? '' : 'disabled-link'}" aria-disabled="${!done}" href="${href(isTransfer ? 'review' : 'condition', { condition: arrival ? 'transfer' : 'arrival', ack: String(acknowledged | (isTransfer ? 2 : arrival ? 4 : 1)) })}">${isTransfer ? '返回整趟审阅' : arrival ? '继续看午餐前接驳' : '继续看出发这段接驳'}${icon('ArrowRight')}</a>`, link('days', '返回当天安排')));
}
function adopted() {
  return `${header()}<main class="content no-bottom"><div class="page-top"><div><h1 class="success-title">${icon('CheckCircle')}暂定行程已采用</h1><p>接下来按这份安排查看每天，仍可调整。未落实的入场、接驳与住宿条件会继续保留。</p></div>${tag('暂定 · 有覆盖缺口', 'unknown')}</div><div class="shared-route-detail"><section><div class="adoption-overview"><header><h3>${r.short} · 11 月 20–25 日</h3><p class="small quiet">${r.stay} · 3 位成人 · 已保留往返航班和固定晚餐</p></header>${summaryRows()}</div><div class="form-buttons">${link('days', '看每日安排', 'primary', { adopted: '1', day: '2' }, 'CalendarBlank')}${link('today', '看 Today 设计情景', 'secondary', { adopted: '1', day: '2' }, 'Sun')}</div></section><aside><div class="practical-note"><strong>仍然是暂定安排</strong>采用不是预订。博物馆当天入场、部分交通、酒店房间与费用仍未落实；你已知悉的记录不会改写为已核验。</div><section class="follow-review"><h3>执行风险跟进已开启</h3><p>当前覆盖天气检查；其他来源缺口在覆盖详情列出。出现变化会保留事件，形成待你确认的调整建议。</p>${link('coverage', '看检查范围', 'text-button', {}, 'Eye')}</section><section class="side-section"><h3>出发前还可以做</h3>${link('prepare', '查看准备事项', 'text-button', {}, 'ListChecks')}<br>${link('share', '分享给同行人', 'text-button', {}, 'ShareNetwork')}<br>${link('journal', '开始旅行手账', 'text-button', {}, 'Notebook')}</section></aside></div></main>${credits()}`;
}
function today() {
  const museum = after;
  return `${header('today')}<main class="content no-bottom"><div class="page-top"><div><h1>早上好，今天慢慢逛京都</h1><p>11 月 21 日，周六 · 日本当地时间 08:15　${tag('出行中情景', 'neutral')}</p></div>${link('days', '完整当天安排', 'secondary', { day: '2' }, 'CalendarBlank')}</div><div class="today-grid"><section><article class="next-stop"><div class="next-stop-content">${tag('下一步 · 08:45 出发', 'suggested')}<h2>${museum ? '去博物馆，留一个室内上午' : '去清水寺看东山秋色'}</h2><p>${museum ? '09:30–11:30 到访。展期和公开票价有依据，当天入场与实际接驳仍需落实，出门前先确认。' : '09:30–11:00 到访。酒店至入口接驳仍未核实；出门前先确认到达方式，避免让长辈走太长的坡路。'}</p>${link('condition', museum ? '看这次入场与接驳条件' : '看这段到达条件', 'secondary', { condition: museum ? 'admission' : 'access' }, 'Info')}</div>${photo(museum ? 'museum' : 'temple')}</article><section class="today-alert"><h3>${icon('CloudRain')}${museum ? '下午可能下雨，祇园短逛受影响' : '上午天气有变化，户外安排受影响'}</h3><p>${museum ? '08:05 的检查提示下午有雨，影响 13:30 的祇园散步。上午博物馆不受这条建议影响；可以缩短户外停留，或提早回酒店。' : '08:05 的检查提示上午有雨，影响清水寺的户外停留。可以保留原安排并备雨具，也可以比较室内博物馆或酒店休息。'}</p><p class="small">这只是建议；当前采用的行程没有被替换。</p>${link(museum ? 'weather-options' : 'compare', '看影响与替代选择', 'secondary', { day: '2' }, 'ArrowRight')}　${link('weather', '看天气依据', 'text-button')}</section><section class="today-prepare"><h3>出门前，先看这几件事</h3><ul><li>${museum ? '先落实博物馆当日入场，再核实酒店至博物馆接驳' : '为长辈确认到达入口的接驳与实际步行负担'}</li><li>带雨具；17:30 固定晚餐时间不变</li><li>酒店房间、入场和交通缺口仍需落实</li></ul></section></section><aside><h3>今天后面的安排</h3>${[[museum ? '12:00' : '11:30', '东山午餐', '自理'], [museum ? '13:30' : '13:00', '祇园短逛', '建议'], [museum ? '15:15' : '14:45', '回酒店休息', '保留休息'], ['17:30', '晚餐', '你已固定']].map(([time, name, status]) => `<div class="today-row"><time>${time}</time><span>${name}</span>${tag(status, status === '你已固定' ? 'recorded' : 'neutral')}</div>`).join('')}<section class="follow-review"><h3>哪些变化有人在看？</h3><p>天气：08:05 最近成功，08:35 下次检查。<br>航班、开放与预约：尚未覆盖。<br>默认在旅行结束后 24 小时停止。</p>${link('coverage', '看跟进覆盖与中断', 'text-button', {}, 'Eye')}</section>${link('journal', '记录今天', 'secondary', {}, 'Camera')}</aside></div></main>${credits()}`;
}
function weatherOptions() {
  return layer(`<main class="content comparison-page"><div class="comparison-top"><div><h1 id="layer-title">午餐后，还要去祇园吗？</h1><p>这次天气变化只影响下午的户外段。上午博物馆、午餐和 17:30 晚餐保留。</p></div></div><div class="afternoon-options"><section class="choice-card"><div class="choice-content">${tag('当前采用安排', 'recorded')}<h3>保留祇园短逛</h3><p class="choice-description">13:30–14:30；带雨具，长辈累了可提早结束。保留这次街区体验，但仍会有户外停留。</p><dl class="choice-dl"><div><dt>影响</dt><dd>酒店休息仍从 15:15 开始</dd></div><div><dt>费用</dt><dd>原交通估算保留，实时条件未知</dd></div></dl>${link('today', '保留原安排', 'secondary')}</div></section><section class="choice-card recommended"><div class="choice-content">${tag('少在雨中走动', 'suggested')}<h3>午餐后直接回酒店</h3><p class="choice-description">不再加另一处景点。少一次户外散步，换来更早回酒店休息，仍保留晚餐时间。</p><dl class="choice-dl"><div><dt>影响</dt><dd>跳过祇园，午餐后改为直接回酒店</dd></div><div><dt>费用</dt><dd>新接驳需核实，不能确定净差额</dd></div></dl>${link('weather-impact', '先预览这次影响', 'primary', {}, 'ArrowRight')}</div></section></div></main>`, '天气变化的局部比较');
}
function weatherImpact() {
  return layer(`<main class="content comparison-page"><h1 id="layer-title">下午少一次散步，早些回酒店</h1><p class="quiet" style="margin-top:12px">这是待采纳建议，当前采用安排继续保留。实际回酒店路线仍需核实。</p><div class="impact-layout"><table class="impact-table"><thead><tr><th>安排</th><th>当前采用</th><th>建议调整</th></tr></thead><tbody><tr class="unchanged"><td>上午与午餐</td><td>博物馆 → 东山午餐</td><td>保持不变</td></tr><tr><td>祇园短逛</td><td>13:30–14:30</td><td>跳过这次到访<small>减少雨中的户外停留</small></td></tr><tr><td>回酒店休息</td><td>15:15 开始</td><td>午餐后直接返回<small>具体到达时间等待接驳核实</small></td></tr><tr class="unchanged"><td>固定晚餐</td><td>17:30</td><td>17:30<small>不移动</small></td></tr></tbody></table><aside class="impact-aside"><h3>需要你决定什么</h3><p class="small quiet">是否放弃这一次祇园短逛。新交通与费用仍未知，不能把“早点回去”写成已核实的具体到达时间。</p><div class="practical-note"><strong>设计范围</strong>本页展示变化建议与采用版的区别。调整采纳继续复用逐项知悉和统一采用流程；当前原型不会保存新行程。</div></aside></div><div class="form-buttons">${link('weather-options', '返回比较', 'secondary')}${link('today', '先保留原行程', 'text-button')}</div></main>`, '变化建议的连带影响');
}
function edit() {
  return layer(`<main class="content"><h1 id="layer-title">想把上午改到几点？</h1><p class="quiet" style="margin-top:12px">修改${after ? '博物馆' : '清水寺'}的到访时间，先看对午餐、休息和固定晚餐的影响。</p><form class="plain-form" id="edit-time-form"><label>到访开始时间<input name="arrival" type="time" value="09:30" required></label><label>预计停留<select name="duration"><option value="90">1 小时 30 分钟</option value="120">2 小时</option></select></label><p>保留：17:30 晚餐、往返航班与其他日期。不会直接保存新时间。</p><div class="form-buttons"><button class="primary" type="submit">先预览连带影响${icon('ArrowRight')}</button>${link('days', '取消', 'secondary')}</div></form></main>`, '调整到访时间');
}
function editPreview() {
  const time = params.get('arrival') || '10:00';
  const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const duration = Number(params.get('duration')) === 120 ? 120 : 90;
  const delta = minutes - 570;
  const downstream = delta + duration - (after ? 120 : 90);
  if ((after ? 915 : 885) + downstream >= 990) return checkState('conflict');
  const format = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return layer(`<main class="content comparison-page"><h1 id="layer-title">将上午开始时间改为 ${time}</h1><p class="quiet" style="margin-top:12px">保留${after ? '博物馆' : '清水寺'}，停留 ${duration} 分钟；只预览开始时间和停留时长的连带变化。</p><div class="impact-layout"><table class="impact-table"><thead><tr><th>安排</th><th>现在</th><th>调整后</th></tr></thead><tbody>${[[after ? '博物馆' : '清水寺', 570], ['午餐', after ? 720 : 690], ['祇园', after ? 810 : 780], ['回酒店休息', after ? 915 : 885]].map(([name, m], index) => `<tr><td>${name}</td><td>${format(m)}</td><td>${format(m + (index === 0 ? delta : downstream))}<small>${index === 0 ? `停留 ${duration} 分钟` : '按停留时长同步预留；实际交通仍待核实'}</small></td></tr>`).join('')}<tr class="unchanged"><td>固定晚餐</td><td>17:30</td><td>17:30<small>保持不动</small></td></tr></tbody></table><aside class="impact-aside"><h3>还需核实</h3><p class="small quiet">新时段开放、交通可行性及是否仍有足够休息时间。时间预留只能用于讨论，不能冒充核验结果。</p></aside></div><div class="result-context">时间修改的设计稿展示到预览为止。正式保存动作将在设计确认后的实现中接入，当前不会写入旅行。</div>${link('edit', '继续改时间', 'secondary')}${link('days', '保留原试排', 'text-button')}</main>`, '时间修改预览');
}
function sourceScreen() {
  return `${header('more')}<main class="content no-bottom"><a class="back-link" href="${href('compare')}">${icon('ArrowLeft')}返回比较</a><h1>依据放在决定旁，也能追溯</h1><p class="quiet small" style="margin-top:12px">本页区分手工核对的公开事实、合成的旅行情景和图片资料。没有建立生产来源连接。</p><div class="source-list"><article class="source-item"><h3>京都国立博物馆 · 开放与票价</h3><p>手工核对日期：2026-11-11。特展 2026/10/6–11/29；通常 09:00–17:30，入场截至 17:00；成人 ¥2,200 日元。仅支持设计日期内的展期与公开票价，不证明当天票务、库存或临时限制。</p>${official('https://www.kyohaku.go.jp/eng/visit/info/', '馆方开放说明')}</article><article class="source-item"><h3>清水寺 · 无障碍参拜</h3><p>官方说明有无障碍路线；不能推断酒店至入口整段可达性。接驳、上下客点、沿途步行负担没有核验。</p>${official('https://www.kiyomizudera.or.jp/en/faq/', '清水寺官方 FAQ')}</article><article class="source-item"><h3>费用、航班、酒店与天气情景</h3><p>方向预算、已记录机票、房间选择、行程时间、接驳增加 ¥1,800 日元与降雨事件均为合成设计资料。不是当前报价、真实预订、实际天气或可执行路线。</p></article><article class="source-item"><h3>照片与地图</h3><p>清水寺全景：lumoplank，CC0。京都国立博物馆建筑：Chainwit.，CC BY 4.0，2020 年。原图未修改，仅按画面裁切显示。Leaflet 地图使用 OpenStreetMap 底图，地点标记为手工放置的近似设计坐标；顺序线不是导航。</p>${official('https://commons.wikimedia.org/wiki/File:Kiyomizu-dera_panorama.jpg', '清水寺原图')} · ${official('https://commons.wikimedia.org/wiki/File:Kyoto_National_Museum_(2020)_-_img_01.jpg', '博物馆原图')} · ${official('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0 许可')}</article><article class="source-item"><h3>图标</h3><p>Phosphor Icons 2.1.10 · MIT。来自项目已安装依赖，许可副本随设计资料保留。</p></article></div></main>`;
}
function more() {
  return `${header('more')}<main class="content no-bottom"><div class="page-top"><div><h1>这趟旅行的其他事情</h1><p>准备、同行协作与旅行记录，不挤进每天安排的主要操作里。</p></div></div><div class="secondary-feature-list">${[['prepare', 'ListChecks', '出发准备', '未落实条件、证件与行李准备；预订跳转与确认记录'], ['transport', 'Train', '完整交通链', '从家出发、往返航班、机场接驳、跨城与返家'], ['budget', 'Notebook', '费用与预算', '已记录、估算与尚未计入的费用分开'], ['share', 'ShareNetwork', '同行人共享', '指定已注册 Google 邮箱，查看或编辑，可撤销'], ['journal', 'Camera', '照片手账', '按天记录，照片与当天到访保持关联'], ['relief', 'Images', '照片浮雕', '从自己的旅行照片进入效果预览'], ['immersion', 'Globe', '目的地沉浸', '先看目的地，再回到当前行程'], ['coverage', 'Eye', '持续跟进', '覆盖、最近成功、下一次检查与来源缺口']].map(([s, i, title, desc]) => `<a class="feature-link" href="${href(s)}">${icon(i)}<div><strong>${title}</strong><p>${desc}</p></div>${icon('CaretRight', 'caret')}</a>`).join('')}</div></main>`;
}
function secondary() {
  const back = `<a class="back-link" href="${href('more')}">${icon('ArrowLeft')}旅行的其他事情</a>`;
  let contents = '';
  if (stage === 'requirements') contents = `<h1>从对话保留的旅行要求</h1><ul class="story-list">${[['CalendarBlank', '11 月 20–25 日，上海往返', '共 6 天，保留已记录往返航班。'], ['Users', '3 位成人，含长辈', '尽量少走长路，下午回酒店休息。'], ['Bed', '预算约人民币 ¥22,000', '需要 2 间房，希望同时体验京都和大阪。'], ['Lock', '11/21 晚餐固定 17:30，餐饮自理', '不自动预订，也不挪动已固定内容。']].map(([i, title, text]) => `<li>${icon(i)}<div><strong>${title}</strong><p>${text}</p></div></li>`).join('')}</ul>${link('handoff', '回到对话修改要求', 'primary', {}, 'ArrowSquareOut')}`;
  if (stage === 'budget') contents = `<h1>预算里，哪些钱有依据？</h1><p class="quiet" style="margin-top:12px">3 人整趟，用户预算约人民币 ¥22,000。以下金额为设计情景。</p><div class="receipt-details"><dl><dt>你记录的机票</dt><dd>人民币 ¥8,400 / 3 人往返，合成用户记录，非真实票据</dd><dt>住宿建议</dt><dd>京都 ¥24,000 日元 / 间 / 晚 × 2 间 × 3 晚；大阪 ¥21,000 日元 / 间 / 晚 × 2 间 × 2 晚。均为情景估价，非供应商报价</dd><dt>交通与餐饮</dt><dd>基础交通人民币约 ¥1,500–2,100，餐饮预留约 ¥3,200–3,800；估算范围不保证可用</dd><dt>新增门票</dt><dd>博物馆 ¥2,200 日元 / 成人 × 3；票务可用性未核实</dd><dt>尚未算定</dt><dd>旧清水寺费用、部分接驳、库存及变价。币种换算仅采用设计汇率 ¥1 日元 ≈ ¥0.05 人民币；不是实时汇率</dd></dl></div><p class="practical-note">预算估算有缺口，不能据此声称整趟 ¥22,000 已经足够，也不能把新增门票和交通简单当成准确净差额。</p>`;
  if (stage === 'transport') contents = `<h1>往返交通是一整条链</h1><p class="quiet" style="margin-top:12px">日期、当地时间、已记录事实与待选接驳放在一起。不会把两段航班当成完整交通。</p><ul class="story-list">${[['Train', '上海市内 → 浦东机场', '自行安排；需根据国际航班办理手续要求确定出发时间。'], ['Airplane', '11/20　PVG 11:00 → KIX 14:20', '已记录的合成航班锚点；上海 UTC+8，日本 UTC+9，飞行约 2 小时 20 分。'], ['Train', `关西机场 → ${route === 'b' ? '大阪' : '京都'}酒店`, '未核实具体班次、全程步行、行李与票价。'], ['ArrowsLeftRight', r.move, '换乘、车次和上下车地点需要真实核实；日程中仅保存时间预留。'], ['Airplane', '11/25　KIX 17:00 → PVG 18:30', '保留已记录的合成返程锚点，飞行约 2 小时 30 分。'], ['Train', '浦东机场 → 家', '自行安排，尚未形成接驳记录。']].map(([i, title, text]) => `<li>${icon(i)}<div><strong>${title}</strong><p>${text}</p></div></li>`).join('')}</ul>`;
  if (stage === 'stay') contents = `<h1>住处已经选了方向，尚未预订</h1><div class="receipt-details"><dl><dt>京都</dt><dd>${route === 'b' ? '不住京都，行李留在大阪' : '都酒店 京都八条，建议 2 间房 / 3 位成人'}</dd><dt>大阪</dt><dd>${route === 'c' ? '不住大阪，当天往返京都' : '大阪日航酒店，建议 2 间房 / 3 位成人'}</dd><dt>未落实</dt><dd>当日库存、具体房型、入住人数、含餐、取消条件与最终价格</dd></dl></div><div class="form-buttons">${link('handoff', '请助手核实房型与价格', 'primary', { topic: 'stay' })}${link('prepare', '看预订与确认记录', 'secondary')}</div>`;
  if (stage === 'prepare') contents = `<h1>出发前，把会卡住行程的事落实</h1><ul class="story-list">${[['Info', '到访与接驳仍有缺口', '博物馆当日入场、酒店至入口、午餐前接驳。回到具体安排旁查看与知悉。'], ['Bed', '住宿尚未预订', '核实 2 间房 / 3 人、入住与取消条件；只提供预订跳转和用户确认记录。'], ['Notebook', '证件、通信与随身物品', '签证与证件由本人准备。敏感证件信息不放入对话或旅行手账。']].map(([i, t, d]) => `<li>${icon(i)}<div><strong>${t}</strong><p>${d}</p></div></li>`).join('')}</ul>${link('review', '回到整趟审阅', 'primary')}`;
  if (stage === 'coverage') contents = `<h1>跟进的范围，要看得见</h1><p class="quiet" style="margin-top:12px">采用行程时明确启用执行风险跟进。以下为合成运行情景，没有真实来源连接。</p><ul class="story-list"><li>${icon('CloudRain')}<div><strong>京都天气 · 已有一次成功检查</strong><p>11/21 08:05 成功，下一次 08:35。发现降雨变化，已形成事件；行程尚未改动。</p></div>${tag('有变化', 'unknown')}</li><li>${icon('Airplane')}<div><strong>航班状态 · 尚未覆盖</strong><p>未连接授权状态来源，不等于“航班没有变化”。</p></div></li><li>${icon('Clock')}<div><strong>场所开放与预约 · 尚未覆盖</strong><p>公开开放资料不是持续监测或真实库存，需要进一步接线。</p></div></li></ul><div class="result-context">默认在 11/26 旅行结束后 24 小时停止。取消旅行或关闭跟进即停止；价格和自定义关注需要对象、触发条件及截止日期。</div>${link('weather', '看一次来源失败的画面', 'secondary', { failure: '1' })}`;
  if (stage === 'weather') contents = `<h1>${params.get('failure') === '1' ? '天气来源暂时无法检查' : '上午降雨变化 · 影响户外到访'}</h1><div class="evidence-quote"><p>${params.get('failure') === '1' ? '08:35 查询失败。最近一次成功仍为 08:05，不能据此认定没有新变化。' : (after ? '08:05 成功检查：京都下午出现降雨信号，影响 13:30 祇园户外散步。上午博物馆与当前采用行程保留。' : '08:05 成功检查：京都上午出现降雨信号，影响 09:30 清水寺户外停留。当前采用行程保留，尚未自动替换。')}</p><small>合成事件，不是真实天气。地点、检查成功与失败、下一次计划分别表达。</small></div><div class="form-buttons">${link('compare', '比较替代安排', 'primary', { after: '0' })}${link('today', '回到 Today', 'secondary')}</div>`;
  if (stage === 'share') contents = `<h1>只分享给你指定的同行人</h1><form class="plain-form" id="share-form"><label>对方已注册的 Google 邮箱<input type="email" name="email" placeholder="输入同行人的 Google 邮箱" required autocomplete="off"></label><label>允许对方<select name="permission"><option>查看这趟旅行</option><option>查看并编辑这趟旅行</option></select></label><p>找到账号后先核对对象，再确认授权；之后可以撤销。邮箱只在这个界面处理，不进入助手上下文。</p><div class="form-buttons"><button class="primary" type="submit">查找账号</button></div><p id="share-feedback" role="status" style="margin-top:16px"></p></form>`;
  if (stage === 'handoff') contents = `<h1>带着当前安排，回到对话继续</h1><div class="plain-form"><label>准备向当前旅行助手提出的请求<textarea readonly>${params.get('topic') === 'lunch' ? '请在11月21日东山午餐时段推荐具体餐厅，适合3位成人含长辈，餐饮自行安排，保持17:30固定晚餐。' : params.get('topic') === 'stay' ? `请继续核实${r.stay}的住宿建议：2间房、3位成人、入住条件与价格。保留已记录航班。` : '请继续调整11月21日的安排，照顾长辈体力，保留下午休息、17:30晚餐与往返航班。先让我查看连带影响，再更新试排。'}</textarea></label><p>正式产品在宿主聊天继续。这个设计原型不连接宿主，不会发送消息。</p><div class="form-buttons">${link('days', '返回行程', 'secondary')}</div></div>`;
  if (stage === 'journal') contents = `<h1>把旅行记下来</h1><p class="quiet" style="margin-top:12px">照片和文字按天归档，保留与到访的关系；行程调整不会删掉已经记录的照片。</p><div class="journal-example">${photo('temple')}<section><span class="eyeless-meta">11 月 21 日 · 京都 · 资料图示例</span><h2>东山的秋天</h2><p>旅行还没有留下自己的记录。到那一天，照片、随手记和这次到访会放在这里。</p><div class="form-buttons">${link('journal-edit', '写一段随手记', 'primary', {}, 'Plus')}${link('relief', '照片浮雕', 'secondary', {}, 'Images')}</div></section></div>`;
  if (stage === 'journal-edit') contents = `<h1>今天想记住什么？</h1><form class="plain-form" id="journal-form"><label>11 月 21 日 · 京都<textarea name="note" placeholder="写下路上的一个瞬间"></textarea></label><p>照片可在正式界面选择并授权读取。设计原型不读取文件，也不上传或保存文字。</p><div class="form-buttons"><button class="primary" type="submit">预览记录</button>${link('journal', '取消', 'secondary')}</div><p id="journal-feedback" role="status"></p></form>`;
  if (stage === 'relief' || stage === 'immersion') contents = `<h1>${stage === 'relief' ? '照片浮雕' : '先去目的地走一走'}</h1><div class="empty-state">${icon(stage === 'relief' ? 'Images' : 'Globe')}<h2>${stage === 'relief' ? '从一张自己的旅行照片开始' : '京都 · 目的地沉浸'}</h2><p>${stage === 'relief' ? '正式界面选择照片后预览浮雕，确认后再保存衍生效果，原图保留。这里先确定入口和返回方式。' : '从当天的到访打开场景，结束后回到同一天、同一地点。这一轮先画入口，沉浸与浮雕画面仍需单独设计。'}</p>${link('journal', '回到旅行手账', 'secondary')}${link('days', '返回当前一天', 'text-button')}</div>`;
  return `${header(['journal', 'journal-edit', 'relief'].includes(stage) ? 'journal' : 'more')}<main class="content no-bottom">${back}${contents}</main>${credits()}`;
}

function board() {
  const active = stageInfo[parentStage] ? parentStage : 'directions';
  const info = stageInfo[active];
  const query = new URLSearchParams(params);
  query.set('frame', '1');
  return `<header class="review-chrome"><div><div class="review-title">Travel Agent · 从选择到出行的交互设计稿</div><p class="review-note">合成案例：3 人带长辈的关西六日游。价格、航班、预订、路线与天气不是实时业务资料；原型不接 MCP、不持久化、不发消息。</p></div><div class="review-device" aria-label="设计视口"><button data-device="desktop" aria-pressed="${params.get('device') !== 'phone'}">桌面</button><button data-device="phone" aria-pressed="${params.get('device') === 'phone'}">手机</button></div><nav class="review-stages" aria-label="评审画面">${Object.entries(stageInfo).map(([key, item]) => `<button data-stage="${key}" ${key === active ? 'aria-current="step"' : ''}>${item[0]}</button>`).join('')}</nav></header><div class="review-guidance"><strong id="review-heading">${info[1]}</strong><span id="review-description">${info[2]}</span></div><main class="review-frame-wrap ${params.get('device') === 'phone' ? 'phone' : ''}"><iframe class="review-frame" title="旅行产品交互设计稿" src="${mediaFrames[stage] ? `./media.html?view=${mediaFrames[stage]}` : `?${query}`}"></iframe><div class="review-footer"><span>十个场景可顺序评审。手机稿为 390 × 844；六个规划场景仍为设计预演，四项记录与共享交互复用已接线组件。</span><span><a id="direct-scene" href="?${query}" target="_blank">单独打开当前画面</a> · <a href="${href('sources')}" target="_blank">资料与授权</a></span></div><nav class="prototype-states" aria-label="辅助状态设计稿"><span>辅助状态：</span>${['loading', 'unavailable', 'conflict', 'edit', 'map', 'more'].map((key, i) => `<button data-scene="${key}">${['检查中', '来源失败', '固定项冲突', '改时间', '地图', '其他功能入口'][i]}</button>`).join('')}</nav></main>`;
}

if (isFrame && mediaFrames[stage]) { location.replace(`./media.html?view=${mediaFrames[stage]}`); } else if (!isFrame) {
  app.innerHTML = board();
  const frame = document.querySelector('iframe');
  const changeScene = next => {
    const q = new URLSearchParams({ frame: '1', stage: next, route: 'a', day: '2', after: ['review', 'condition', 'today'].includes(next) ? '1' : '0', adopted: next === 'today' ? '1' : '0', ack: next === 'today' ? '7' : '0' });
    frame.src = mediaFrames[next] ? `./media.html?view=${mediaFrames[next]}` : `?${q}`;
  };
  document.querySelectorAll('[data-stage]').forEach(button => button.addEventListener('click', () => changeScene(button.dataset.stage)));
  document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => changeScene(button.dataset.scene)));
  document.querySelectorAll('[data-device]').forEach(button => button.addEventListener('click', () => {
    const phone = button.dataset.device === 'phone';
    document.querySelector('.review-frame-wrap').classList.toggle('phone', phone);
    document.querySelectorAll('[data-device]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    const q = new URLSearchParams(location.search); q.set('device', phone ? 'phone' : 'desktop'); history.replaceState(null, '', `?${q}`);
  }));
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'travel-design-scene') return;
    const next = event.data.parentStage;
    if (!stageInfo[next]) return;
    document.querySelector('#review-heading').textContent = stageInfo[next][1];
    document.querySelector('#review-description').textContent = stageInfo[next][2];
    document.querySelectorAll('[data-stage]').forEach(button => { if (button.dataset.stage === next) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
    document.querySelector('#direct-scene').href = event.data.url;
    const q = new URLSearchParams(event.data.query); q.delete('frame');
    q.set('device', document.querySelector('.review-frame-wrap').classList.contains('phone') ? 'phone' : 'desktop');
    history.replaceState(null, '', `?${q}`);
  });
} else {
  document.body.className = `frame-body variant-${variant}`;
  const renderers = { 'weather-options': weatherOptions, 'weather-impact': weatherImpact, directions, days: daily, compare, impact, review, condition, adopted, today, edit, 'edit-preview': editPreview, sources: sourceScreen, more, map: () => `${header()}${tripBar()}<main class="content no-bottom"><a class="back-link" href="${href('days')}">${icon('ArrowLeft')}返回当天安排</a><h1>把地点放回真实位置</h1><p class="quiet small" style="margin:12px 0 22px">地点标记为近似设计坐标；点标记返回对应到访。连线不是导航路线。</p>${mapShell()}</main>` };
  app.innerHTML = `<div class="product">${renderers[stage] ? renderers[stage]() : ['loading', 'unavailable', 'conflict'].includes(stage) ? checkState(stage) : secondary()}</div>`;
  if (window.parent !== window) window.parent.postMessage({ type: 'travel-design-scene', parentStage, url: location.href, query: location.search }, location.origin);

  document.querySelectorAll('[data-candidate]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-candidate]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    document.querySelectorAll('[data-choice]').forEach(card => card.classList.toggle('mobile-selected', card.dataset.choice === button.dataset.candidate));
    const action = document.querySelector(`[data-choice="${button.dataset.candidate}"] .choice-content>a.primary, [data-choice="${button.dataset.candidate}"] .choice-content>a.secondary`);
    document.querySelector('#mobile-candidate-action').replaceChildren(action.cloneNode(true));
  }));
  if (params.get('focus')) document.querySelector(`#morning-${params.get('focus') === 'time' ? 'time' : params.get('focus') === 'condition' ? 'condition' : 'choice'}`)?.focus();
  if (document.querySelector('.decision-drawer')) document.addEventListener('keydown', event => { if (event.key === 'Escape') location.href = document.querySelector('.layer-header>a').href; });
  const ack = document.querySelector('#condition-ack');
  if (ack) ack.addEventListener('change', () => {
    const next = document.querySelector('#condition-continue');
    next.classList.toggle('disabled-link', !ack.checked); next.setAttribute('aria-disabled', String(!ack.checked));
    document.querySelector('#condition-feedback').textContent = ack.checked ? '设计场景：已知悉，事实仍未核实。正式实现会保存到当前账号的同一旅行。' : '这项尚未知悉。勾选不表示事实已经核验。';
  });
  document.querySelector('#condition-continue')?.addEventListener('click', event => { if (!ack.checked) event.preventDefault(); });
  document.querySelector('#edit-time-form')?.addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.currentTarget); location.href = href('edit-preview', { arrival: data.get('arrival'), duration: data.get('duration') }); });
  document.querySelector('#share-form')?.addEventListener('submit', event => { event.preventDefault(); document.querySelector('#share-feedback').textContent = '设计原型未连接账号服务，没有查找、发送或授权。正式流程会先显示匹配账号供你核对。'; });
  document.querySelector('#journal-form')?.addEventListener('submit', event => { event.preventDefault(); document.querySelector('#journal-feedback').textContent = '这段文字仅在当前设计页面中；没有保存或上传。'; });
  if (['compare', 'impact', 'weather-options', 'weather-impact', 'condition', 'edit', 'edit-preview', 'loading', 'unavailable', 'conflict'].includes(stage)) {
    document.querySelector('#layer-title')?.setAttribute('tabindex', '-1');
    document.querySelector('#layer-title')?.focus({ preventScroll: true });
  }
  const element = document.querySelector('#trip-map');
  if (element && !document.querySelector('.layer-underlay')) {
    const map = L.map(element, { scrollWheelZoom: false, zoomControl: false }).setView(day === 2 ? [34.9950, 135.771] : [34.91, 135.55], day === 2 ? 13 : 8);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' }).addTo(map);
    let failed = false;
    tiles.on('tileerror', () => { if (failed) return; failed = true; const note = document.createElement('div'); note.className = 'map-error'; note.textContent = '底图暂时无法完整加载。地点与当天安排保留，可稍后重试。'; element.parentElement.append(note); });
    const stops = mapStops();
    stops.forEach(([lat, lng, id, number, title]) => {
      const marker = L.marker([lat, lng], { title, icon: L.divIcon({ className: `stop-marker ${(params.get('stop') || 'morning') === id ? 'selected' : ''}`, html: number, iconSize: [27, 27], iconAnchor: [13, 13] }) }).addTo(map);
      if (day === 2 && ['morning', 'gion', 'hotel'].includes(id)) marker.on('click', () => { location.href = `${href('days', { day: '2', stop: id })}#stop-${id}`; });
      else marker.bindPopup(title);
    });
    map.fitBounds(stops.map(item => [item[0], item[1]]), { padding: [55, 55], maxZoom: 13 });
    if (day === 2) L.polyline(stops.map(item => [item[0], item[1]]), { color: '#a86750', dashArray: '4 6', weight: 2, opacity: .65 }).addTo(map);
  }
}
