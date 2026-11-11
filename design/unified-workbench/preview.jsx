import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TurnsuFrame, TurnsuSession } from "../../src/web/workspace/TurnsuFrame.jsx";
import { JournalPanel } from "../../src/web/workspace/JournalPanel.jsx";
import { SharingPanel } from "../../src/web/workspace/SharingPanel.jsx";
import { DestinationExperience } from "../../src/web/workspace/DestinationExperience.jsx";
import { MainPlanOverview, DecisionComparison } from "../../src/web/decision-workspace.jsx";
import { host, tripId, locations, visits } from "./design-host.mjs";
import "../../src/web/styles.css";
import "./preview.css";

const trip = { destination: "京都与大阪", dates: ["2026-11-20", "2026-11-25"], travelerCount: 3, totalBudget: 26000 };
const nodes = [
  { nodeId: "stay", title: "京都站附近住宿", domain: "stay", summary: "两间房；入住条件与报价尚待核验", schedule: { date: "2026-11-21", startTime: "08:30" } },
  { nodeId: "kyoto-temple", title: "清水寺", domain: "play", summary: "慢慢看屋檐与秋色", schedule: { date: "2026-11-21", startTime: "10:00" } },
  { nodeId: "lunch", title: "东山附近午餐", domain: "food", summary: "给长辈留足休息时间；餐厅待选择", schedule: { date: "2026-11-21", startTime: "12:30" } },
  { nodeId: "kyoto-museum", title: "京都国立博物馆", domain: "play", summary: "雨天备选，开放与预约尚待核验", schedule: { date: "2026-11-22", startTime: "10:00" } },
];
function Preview() {
  const [page, setPage] = useState(new URLSearchParams(location.search).get("view") || "overview");
  const [share, setShare] = useState(false), [explore, setExplore] = useState(false), [context, setContext] = useState(null);
  const [journalStatus, setJournalStatus] = useState({});
  function navigate(next) {
    if (journalStatus.busy || journalStatus.uncertain) { window.alert("请先在手账里核对当前保存结果。"); return; }
    if (journalStatus.dirty && !window.confirm("放弃尚未保存的手账编辑？")) return;
    setJournalStatus({}); setContext(null); setPage(next); history.replaceState(null, "", `?view=${next}`);
  }
  return <TurnsuFrame active={page} onNavigate={navigate} tripTitle="京都与大阪 · 六日" onTrips={() => navigate("overview")} onShare={() => setShare(true)} footer={<small>交互设计 · 合成旅行<br />照片来源见本目录 assets/sources.json</small>}>
    <div className="unified-design-notice">可操作设计稿 · 虚构旅行与账号 · 内存预演，刷新重置，不连接业务服务</div>
    <main className="unified-design-content"><header className="unified-trip-heading"><div><h1>京都与大阪</h1><p>11 月 20–25 日 · 3 位成人，含长辈</p></div><button className="ui-secondary" onClick={() => setShare(true)}>共享旅行</button></header>
      {page === "journal" ? <JournalPanel host={host} tripId={tripId} revision={0} canEdit visits={visits} place={context} selectedDate={context?.date || ""} onStatusChange={setJournalStatus} tripTitle="京都与大阪 · 六日" onClose={() => navigate("overview")} /> : page === "overview" ? <>
        <MainPlanOverview trip={trip} plan={{}} nodes={nodes} draft onCompare={() => navigate("compare")} onMap={() => navigate("map")} onEdit={() => window.alert("旅行要求沿用另一会话已实现的编辑层。此页聚焦统一导航与记录交互。")} onDetails={id => { setExplore(id); }} />
        <div className="unified-design-actions"><button className="ui-secondary" onClick={() => { setContext({ date: "2026-11-21" }); setPage("journal"); }}>记录这一天</button><button className="ui-secondary" onClick={() => setExplore("kyoto-temple")}>探索目的地</button></div>
      </> : page === "compare" ? <DecisionComparison domain="play" nodes={nodes.filter(n => n.domain === "play")} onSelect={n => setExplore(n.nodeId)} onDetails={setExplore} onResearch={() => setPage("overview")} /> : <section className="unified-design-handoff"><h2>{({ map: "地图与路线", watches: "价格关注", preferences: "旅行偏好" })[page]}</h2><p>这部分继续使用主旅行画布的现有服务和交互。统一设计稿保留导航位置；本页不生成路线或报价。</p><button className="ui-secondary" onClick={() => navigate("overview")}>返回每日行程</button></section>}
      {share && <SharingPanel host={host} tripId={tripId} tripTitle="京都与大阪 · 六日" onClose={() => setShare(false)} />}
      {explore && <DestinationExperience {...(locations.find(l => l.place.sourceId === explore) || locations[0])} locations={locations} canEdit onJournal={place => { setExplore(false); setContext({ name: place.name }); setPage("journal"); }} onClose={() => setExplore(false)} />}
    </main>
  </TurnsuFrame>;
}
createRoot(document.getElementById("root")).render(<TurnsuSession><Preview /></TurnsuSession>);
