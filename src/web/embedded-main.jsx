import { TurnsuSession, TurnsuFrame } from "./workspace/TurnsuFrame.jsx";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMcpHostBridge, createClaudeArtifactBridge } from "./host-bridge.js";
import { createMcpTravelClient } from "./travel-client.js";
import { configureTravelClient } from "./api-client.js";
import { EmbeddedWorkspace } from "./embedded-workspace.jsx";
import "./styles.css";
let bridge, opening = 0;
const mount = createRoot(document.getElementById("root"));
function Bootstrap({ connection, current }) {
  const [status, setStatus] = useState("connecting");
  useEffect(() => { let active = true; connection.then(() => { if (active) setStatus("connected"); }, () => { if (active) setStatus("failed"); }); return () => { active = false; }; }, [connection]);
  if (status === "connected") return <EmbeddedWorkspace bridge={current} />;
  return <TurnsuFrame navigation={[]} tripTitle="旅行工作台"><main className="turnsu-connecting"><h1>Turnsu 旅行</h1>{status === "failed" ? <><p role="alert">暂时未能连接宿主。已保存的旅行仍保留，请检查插件连接后重试。</p><button className="ui-primary" type="button" onClick={start}>重新连接</button></> : <p role="status">正在连接旅行工作台…</p>}</main></TurnsuFrame>;
}
function start() {
  bridge?.dispose();
  bridge = globalThis.TRAVEL_ARTIFACT_CONNECTOR ? createClaudeArtifactBridge(globalThis.TRAVEL_ARTIFACT_CONNECTOR) : createMcpHostBridge();
  const current = bridge; globalThis.travelHost = current; configureTravelClient(createMcpTravelClient(current));
  const connection = current.initialize().then(() => {
    document.documentElement.dataset.travelEmbedded = current.kind;
    current.onResult(value => {
      const conversationId = value?.conversation?.conversationId ?? value?.conversationId;
      const tripId = value?.tripId ?? value?.conversation?.tripId;
      if (conversationId) current.initialConversationId = conversationId;
      if (tripId) current.initialTripId = tripId;
      if (conversationId || tripId) window.dispatchEvent(new CustomEvent("travel:workspace-open", { detail: { conversationId, tripId } }));
    });
  });
  mount.render(<StrictMode><TurnsuSession key={++opening}><Bootstrap connection={connection} current={current} /></TurnsuSession></StrictMode>);
}
document.addEventListener("click", event => {
  const anchor = event.target.closest?.("a[href]");
  if (anchor && /^https:\/\//.test(anchor.href) && bridge) { event.preventDefault(); void bridge.openLink(anchor.href); }
});
start();
