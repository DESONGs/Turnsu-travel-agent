import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { JournalPanel, ReliefEditor } from "../../plugins/travel-agent-openai/workbench/src/JournalPanel.jsx";
import { SharingPanel } from "../../plugins/travel-agent-openai/workbench/src/SharingPanel.jsx";
import { DestinationExperience } from "../../plugins/travel-agent-openai/workbench/src/DestinationExperience.jsx";
import { shareEmailDigest } from "../../plugins/travel-agent-openai/workbench/src/share-email.mjs";
import { Icon } from "../../plugins/travel-agent-openai/workbench/src/Icon.jsx";
import "./screens.css";
import "./media.css";

// Explicit design-only host. The plugin never imports this module.
const tripId = '10000000-0000-4000-8000-000000000001';
const imageA = '10000000-0000-4000-8000-000000000002', imageB = '10000000-0000-4000-8000-000000000003';
const imageC = '10000000-0000-4000-8000-000000000007';
const first = '10000000-0000-4000-8000-000000000004';
const recipe = { version: 'photo-relief-v1', horizon: .48, depth: .65, style: 'ink' };
const encode = async path => { const blob = await (await fetch(path)).blob(); return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob); }); };
const sources = { [imageA]: await encode('./assets/kiyomizu.jpg'), [imageB]: await encode('./assets/kyoto-museum.jpg') };
sources[imageC] = sources[imageB];
document.body.classList.add('design-media');
let entries = [
  { entryId: first, title: '东山的秋天', placeTitle: '', note: '上午慢慢看屋檐与秋色。\n\n没有再赶第二个寺院，下午回酒店前，留了一段坐下来休息的时间。', takenOn: '2026-11-21', stage: 'visited', subject: 'landscape', entryRevision: 0, visitStopId: 'visit-temple', photos: [{ photoId: imageA, index: 0, relief: recipe }, { photoId: imageB, index: 1, relief: null }] },
  { entryId: '10000000-0000-4000-8000-000000000005', title: '回酒店前的一段散步', placeTitle: '', note: '今天没有一定要去的下一站。\n\n吃过午饭，沿街慢慢走。累了就坐一会儿，再一起回酒店。', takenOn: '2026-11-22', stage: 'visited', subject: 'landscape', entryRevision: 0, photos: [] },
  { entryId: '10000000-0000-4000-8000-000000000006', title: '建筑的一角', placeTitle: '', note: '先留下一张喜欢的建筑资料图，等真的到了，再换上自己的照片。', takenOn: '2026-11-20', stage: 'wish', subject: 'building', entryRevision: 0, photos: [{ photoId: imageC, index: 0, relief: null }] },
];
let accessRevision = 0;
let members = [{ accountId: '10000000-0000-4000-8000-000000000010', name: '林青', email: 'lin@example.com', role: 'viewer' }];
const newAccount = { accountId: '10000000-0000-4000-8000-000000000011', name: '陈川', email: 'chen@example.com', emailAuthoritative: true };
const registeredHash = await shareEmailDigest(newAccount.email);
const receipts = new Map();
const failure = (code, message) => { throw Object.assign(new Error(message), { code }); };
const host = { async call(name, args) {
  if (name === 'list_trip_journal') return { items: structuredClone(entries) };
  if (name === 'read_trip_journal_image') return { mimeType: 'image/jpeg', data: sources[args.photoId] };
  if (name === 'get_trip_journal_entry') return { entry: structuredClone(entries.find(item => item.entryId === args.entryId)) };
  if (name === 'list_trip_share_members') return { items: structuredClone(members), accessRevision };
  if (name === 'resolve_trip_share_email') { if (args.emailHash !== registeredHash) failure('share_account_unavailable', '未找到这个已注册账号。设计案例可使用 chen@example.com；不会查询真实账号。'); return { ...newAccount, accessRevision }; }
  if (receipts.has(args.requestId)) return structuredClone(receipts.get(args.requestId));
  let result;
  if (name === 'save_trip_journal_entry') {
    const old = entries.find(item => item.entryId === args.entryId);
    if (old && old.entryRevision !== args.expectedEntryRevision) failure('journal_revision_conflict', '这条设计记录已发生变化，请重新读取。');
    for (const photo of args.photos) if (photo.data) sources[photo.photoId] = photo.data;
    const item = { ...args, placeTitle: '', entryRevision: old ? old.entryRevision + 1 : 0, photos: args.photos.map((photo, index) => ({ photoId: photo.photoId, index, relief: photo.relief || null })) };
    entries = [item, ...entries.filter(entry => entry.entryId !== item.entryId)]; result = { status: 'saved', entry: item, appliedEntryRevision: item.entryRevision };
  } else if (name === 'save_trip_photo_relief') {
    const item = entries.find(entry => entry.entryId === args.entryId);
    if (item.entryRevision !== args.expectedEntryRevision) failure('journal_revision_conflict', '记录已发生变化，请重新打开照片。');
    item.photos = item.photos.map(photo => photo.photoId === args.photoId ? { ...photo, relief: args.relief } : photo); item.entryRevision++; result = { status: 'saved', entry: item, appliedEntryRevision: item.entryRevision };
  } else if (name === 'delete_trip_journal') { entries = entries.filter(item => item.entryId !== args.entryId); result = { status: 'deleted' }; }
  else if (['grant_trip_share_email', 'grant_trip_access', 'revoke_trip_access'].includes(name)) {
    if (args.expectedAccessRevision !== accessRevision) failure('access_revision_conflict', '共享列表已发生变化，请重新读取。');
    if (name === 'revoke_trip_access') { members = members.filter(item => item.accountId !== args.accountId); result = { revoked: true }; }
    else { members = [...members.filter(item => item.accountId !== args.accountId), { ...newAccount, ...(members.find(item => item.accountId === args.accountId) || {}), role: args.role }]; result = { role: args.role }; }
    accessRevision++;
  } else failure('not_in_design', '这个操作不在当前设计案例中。');
  receipts.set(args.requestId, structuredClone(result)); return structuredClone(result);
} };
const locations = [
  { place: { sourceId: 'kyoto-temple', name: '清水寺', type: '寺院', coordinates: { longitude: 135.785, latitude: 34.9949, coordinateSystem: 'WGS-84' } }, domain: 'play' },
  { place: { sourceId: 'kyoto-museum', name: '京都国立博物馆', type: '博物馆', coordinates: { longitude: 135.773, latitude: 34.9896, coordinateSystem: 'WGS-84' } }, domain: 'play' },
];
const visits = [{ stopId: 'visit-temple', name: '清水寺', date: '2026-11-21' }, { stopId: 'visit-museum', name: '京都国立博物馆', date: '2026-11-21' }];
const none = () => {};
function MediaDesign() {
  const [journalStatus, setJournalStatus] = useState({ dirty:false, busy:false, uncertain:false });
  const [effectDirty, setEffectDirty] = useState(false);
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') || 'journal');
  const [effectBusy, setEffectBusy] = useState(false), [effectError, setEffectError] = useState(null), [effectVersion, setEffectVersion] = useState(0);
  useEffect(() => { history.replaceState(null,'',`?view=${view}`); const stage = { journal: 'journal', relief: 'relief', destination: 'immersion', share: 'share' }[view] || 'journal'; if (window.parent !== window) window.parent.postMessage({ type: 'travel-design-scene', parentStage: stage, url: location.href, query: `?stage=${stage}` }, location.origin); }, [view]);
  function allowLeave() {
    if (journalStatus.busy || effectBusy) return false;
    if (journalStatus.uncertain) return window.confirm('保存结果尚未确认。切换后请先重开核对，不要重复新建。确定切换？');
    return !(journalStatus.dirty || effectDirty) || window.confirm('还有未保存的内容。确定放弃本次编辑并切换？取消可继续编辑。');
  }
  function switchView(next) { if (next !== view && allowLeave()) { setJournalStatus({dirty:false,busy:false,uncertain:false}); setEffectDirty(false); setView(next); } }
  const current = entries.find(item => item.entryId === first), photo = current?.photos[0];
  return <><div class="prototype-strip">交互设计稿 · 合成案例与虚构账号 · 仅内存预演，刷新重置，不连接业务服务</div><header class="media-preview-header"><a href="./" onClick={event => { if (!allowLeave()) event.preventDefault(); }}>Travel / 关西六日</a><nav>{[['journal','照片手账'],['relief','照片浮雕'],['destination','目的地沉浸'],['share','共享授权']].map(([key,label]) => <button type="button" aria-current={view === key ? 'page' : undefined} onClick={() => switchView(key)}>{label}</button>)}</nav></header><div class="media-preview-context"><span>经典慢游 · 京都 3 晚＋大阪 2 晚 · 11 月 20–25 日</span><span>3 位成人，含长辈</span></div><main class="media-preview-main">
    {view === 'journal' && <JournalPanel key="journal" host={host} tripId={tripId} revision={0} canEdit visits={visits} selectedDate="2026-11-21" onClose={() => { location.href = './?stage=days'; }} onStatusChange={setJournalStatus} tripTitle="关西六日 · 11 月 20–25 日" />}
    {view === 'relief' && current && photo && <ReliefEditor key={effectVersion} entry={current} photo={photo} src={`data:image/jpeg;base64,${sources[photo.photoId]}`} canEdit busy={effectBusy} error={effectError} onDirty={setEffectDirty} onClose={() => setView('journal')} onSave={async relief => { setEffectBusy(true); try { await host.call('save_trip_photo_relief',{ tripId, entryId: first, expectedEntryRevision: current.entryRevision, photoId: photo.photoId, relief, requestId:crypto.randomUUID() }); setEffectVersion(value=>value+1); } catch(failure) { setEffectError(failure.message); } finally {setEffectBusy(false);} }} />}
    {view === 'share' && <SharingPanel host={host} tripId={tripId} tripTitle="关西六日 · 设计情景" onClose={() => setView('journal')} />}
    {view === 'destination' && <DestinationExperience {...locations[0]} locations={locations} onClose={() => setView('journal')} />}
    {view !== 'journal' && <div class="media-preview-return">正在查看独立交互设计稿。关闭侧层返回照片手账。</div>}
  </main><footer class="credit-strip">资料图：清水寺 lumoplank / CC0；京都国立博物馆 Chainwit. / CC BY 4.0（2020）。<a href="./?frame=1&stage=sources">来源与授权</a>。人物、旅行和预订情境均为虚构。</footer></>;
}
render(<MediaDesign />, document.querySelector('#app'));
