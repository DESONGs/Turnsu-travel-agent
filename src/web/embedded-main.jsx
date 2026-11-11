import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMcpHostBridge, createClaudeArtifactBridge } from "./host-bridge.js";
import { createMcpTravelClient } from "./travel-client.js";
import { configureTravelClient } from "./api-client.js";
import { EmbeddedWorkspace } from "./embedded-workspace.jsx";
import "./styles.css";

let bridge;
async function start() {
  const root = document.getElementById("root");
  bridge?.dispose();
  bridge = globalThis.TRAVEL_ARTIFACT_CONNECTOR ? createClaudeArtifactBridge(globalThis.TRAVEL_ARTIFACT_CONNECTOR) : createMcpHostBridge();
  globalThis.travelHost = bridge;
  configureTravelClient(createMcpTravelClient(bridge));
  root.textContent = "Connecting Travel Agent…";
  try {
    await bridge.initialize();
    document.documentElement.dataset.travelEmbedded = bridge.kind;
    bridge.onResult(value => {
      const conversationId = value?.conversation?.conversationId ?? value?.conversationId;
      if (conversationId) bridge.initialConversationId = conversationId;
      if (conversationId) window.dispatchEvent(new CustomEvent("travel:workspace-open", { detail: { conversationId } }));
    });
    createRoot(root).render(<StrictMode><EmbeddedWorkspace bridge={bridge} /></StrictMode>);
  } catch {
    root.replaceChildren();
    const message = document.createElement("p"); message.setAttribute("role", "alert"); message.textContent = "Connect the Travel Agent plugin and enable its workspace connector to open your saved trips.";
    const retry = document.createElement("button"); retry.textContent = "Reconnect"; retry.onclick = start;
    root.append(message, retry);
  }
}
document.addEventListener("click", event => {
  const anchor = event.target.closest?.("a[href]");
  if (anchor && /^https:\/\//.test(anchor.href) && bridge) { event.preventDefault(); void bridge.openLink(anchor.href); }
});
void start();
