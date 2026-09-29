const SOFT_KEYBOARD_INPUT_TYPES = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);

export function isTextEntryTarget(element) {
  if (!element) return false;
  const tagName = String(element.tagName || "").toUpperCase();
  if (tagName === "TEXTAREA") return true;
  if (tagName === "INPUT") return SOFT_KEYBOARD_INPUT_TYPES.has(String(element.type || "text").toLowerCase());
  return element.isContentEditable === true || element.contentEditable === "true";
}

export function shouldHideMobileNavigation({
  layoutWidth,
  layoutHeight,
  viewportWidth,
  viewportHeight,
  activeElement,
}) {
  if (layoutWidth >= 900 || !isTextEntryTarget(activeElement)) return false;
  const unscaledViewport = Math.abs(viewportWidth - layoutWidth) <= 4;
  const keyboardOcclusion = layoutHeight - viewportHeight > 120;
  return unscaledViewport && keyboardOcclusion;
}
