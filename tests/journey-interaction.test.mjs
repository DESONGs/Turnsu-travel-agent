import test from "node:test";
import assert from "node:assert/strict";
import { shouldSendComposerKey, nextTrialNodeId, runJourneyAction, hasRouteMeasurements, hasTripMapPoints } from "../src/web/journey-interaction.js";

test("an acknowledged action stays delivered when its follow-up read fails", async () => {
  const calls = [];
  const receipt = { status: "committed", tripId: "trip-1" };
  const error = new Error("read unavailable");
  const result = await runJourneyAction({
    perform: async () => { calls.push("write"); return receipt; },
    onDelivered: () => calls.push("receipt"),
    synchronize: async () => { calls.push("read"); throw error; },
  });
  assert.equal(result.receipt, receipt);
  assert.equal(result.syncError, error);
  assert.deepEqual(calls, ["write", "receipt", "read"]);
});

test("rejected writes are not acknowledged or refreshed", async () => {
  let acknowledged = false;
  const error = new Error("needs_rebase");
  await assert.rejects(runJourneyAction({
    perform: async () => { throw error; },
    onDelivered: () => { acknowledged = true; },
    synchronize: async () => { throw new Error("must not read"); },
  }), error);
  assert.equal(acknowledged, false);
});

test("successful action synchronizes once and returns its receipt", async () => {
  let reads = 0;
  const result = await runJourneyAction({
    perform: async () => ({ conversation: { conversationId: "chat" } }),
    synchronize: async () => { reads++; },
  });
  assert.equal(result.syncError, null);
  assert.equal(result.receipt.conversation.conversationId, "chat");
  assert.equal(reads, 1);
});

test("Chinese IME confirmation is not interpreted as sending the trip request", () => {
  assert.equal(shouldSendComposerKey({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSendComposerKey({ key: "Enter", isComposing: false, keyCode: 229 }), false);
  assert.equal(shouldSendComposerKey({ key: "Process", keyCode: 229 }), false);
});

test("composer retains explicit send and multiline keyboard behavior", () => {
  assert.equal(shouldSendComposerKey({ key: "Enter", isComposing: false, keyCode: 13 }), true);
  assert.equal(shouldSendComposerKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSendComposerKey({ key: "a" }), false);
});

test("a first draft can be cancelled before anything is confirmed", () => {
  let selected = nextTrialNodeId(undefined, "stay-first");
  assert.equal(selected, "stay-first");
  selected = nextTrialNodeId(selected, "stay-first");
  assert.equal(selected, null);
});

test("trying another candidate replaces only the UI choice, and remains reversible", () => {
  const next = nextTrialNodeId("stay-first", "stay-second");
  assert.equal(next, "stay-second");
  assert.equal(nextTrialNodeId(next, "stay-second"), null);
});

test("missing route evidence never becomes a zero-minute trip", () => {
  assert.equal(hasRouteMeasurements(null), false);
  assert.equal(hasRouteMeasurements({ legs: [] }), false);
  assert.equal(hasRouteMeasurements({ legs: [{ recommendedMode: "walk", alternatives: [] }] }), false);
  assert.equal(hasRouteMeasurements({ legs: [{ recommendedMode: "walk", alternatives: [{ mode: "walk", totalMinutes: null }] }] }), false);
  assert.equal(hasRouteMeasurements({ legs: [{ recommendedMode: "walk", alternatives: [{ mode: "walk", totalMinutes: 12 }] }] }), true);
  assert.equal(hasRouteMeasurements({ legs: [{ recommendedMode: "walk", alternatives: [{ mode: "walk", totalMinutes: 0 }] }] }), true);
});

test("map footprint is compact only when both places and route endpoints lack valid points", () => {
  assert.equal(hasTripMapPoints([{ location: { coordinates: { longitude: null, latitude: null } } }]), false);
  assert.equal(hasTripMapPoints([{ location: { coordinates: { longitude: 181, latitude: 31 } } }]), false);
  assert.equal(hasTripMapPoints([{ location: { coordinates: { longitude: 121.4, latitude: 31.2 } } }]), true);
  assert.equal(hasTripMapPoints([], { legs: [{ origin: { coordinates: { longitude: 0, latitude: 0 } } }] }), true);
});
