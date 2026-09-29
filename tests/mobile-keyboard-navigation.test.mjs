import assert from "node:assert/strict";
import test from "node:test";
import { shouldHideMobileNavigation } from "../src/web/mobile-keyboard-state.js";

const mobileViewport = { layoutWidth: 390, layoutHeight: 844 };

test("mobile navigation stays visible for responsive scaling without a text-entry focus", () => {
  assert.equal(shouldHideMobileNavigation({ ...mobileViewport, viewportWidth: 134, viewportHeight: 290, activeElement: { tagName: "BUTTON" } }), false);
  assert.equal(shouldHideMobileNavigation({ ...mobileViewport, viewportWidth: 134, viewportHeight: 290, activeElement: { tagName: "TEXTAREA" } }), false);
});

test("mobile navigation hides only while a real soft-keyboard-sized viewport occlusion is active", () => {
  assert.equal(shouldHideMobileNavigation({ ...mobileViewport, viewportWidth: 390, viewportHeight: 520, activeElement: { tagName: "TEXTAREA" } }), true);
  assert.equal(shouldHideMobileNavigation({ ...mobileViewport, viewportWidth: 390, viewportHeight: 760, activeElement: { tagName: "TEXTAREA" } }), false);
  assert.equal(shouldHideMobileNavigation({ ...mobileViewport, viewportWidth: 390, viewportHeight: 520, activeElement: { tagName: "INPUT", type: "file" } }), false);
});

test("desktop navigation state is never treated as a mobile soft keyboard", () => {
  assert.equal(shouldHideMobileNavigation({ layoutWidth: 1280, layoutHeight: 800, viewportWidth: 1280, viewportHeight: 520, activeElement: { tagName: "TEXTAREA" } }), false);
});
