// The design system uses data-theme for controls and .dark for its base palette.
function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function setHostTheme(theme) {
  if (typeof document === "undefined" || !["dark", "light"].includes(theme)) return;
  document.documentElement.dataset.hostTheme = theme;
  applyTheme(theme);
}

export function initializeWorkspaceTheme() {
  document.documentElement.dataset.series = "workspace";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => applyTheme(document.documentElement.dataset.hostTheme || (system.matches ? "dark" : "light"));
  sync();
  system.addEventListener("change", sync);
  if (import.meta.hot) import.meta.hot.dispose(() => system.removeEventListener("change", sync));
}
