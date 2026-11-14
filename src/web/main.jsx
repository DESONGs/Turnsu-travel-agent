import { TurnsuSession } from "./workspace/TurnsuFrame.jsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TravelApp } from "./travel-app.jsx";
import "./design-system/travel-theme.css";

createRoot(document.getElementById("root")).render(
  <StrictMode><TurnsuSession><TravelApp /></TurnsuSession></StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => null));
}
