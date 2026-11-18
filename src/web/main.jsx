import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TravelApp } from "./travel-app.jsx";
import "./design-system/travel-theme.css";
import { initializeWorkspaceTheme } from "./design-system/workspace-theme.js";

initializeWorkspaceTheme();

createRoot(document.getElementById("root")).render(
  <StrictMode><TravelApp /></StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => null));
}
