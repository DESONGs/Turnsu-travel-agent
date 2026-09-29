import assert from "node:assert/strict";
import test from "node:test";
import { createDestinationCameraPlayback } from "../src/web/amap-map-renderer.js";

const beat = (key, longitude, latitude, duration) => ({
  key,
  center: { longitude, latitude, coordinateSystem: "GCJ-02" },
  zoom: key === "place" ? 17 : 14,
  pitch: key === "place" ? 62 : 48,
  rotation: key === "place" ? 34 : 12,
  duration,
});

function timerHarness() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
  };
}

function fakeMap() {
  const calls = [];
  return {
    calls,
    setPitch(value) { calls.push(["pitch", value]); },
    setRotation(value) { calls.push(["rotation", value]); },
    setZoomAndCenter(zoom, center, animated, duration) { calls.push(["camera", zoom, center, animated, duration]); },
  };
}

test("destination camera playback schedules beats and clears pending timers on stop", () => {
  const map = fakeMap();
  const timers = timerHarness();
  const playback = createDestinationCameraPlayback({
    map,
    beats: [beat("area", 120.15, 30.25, 1600), beat("place", 120.14, 30.26, 2400), beat("route", 120.145, 30.255, 1800)],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  playback.start();
  assert.equal(playback.pendingTimers, 3);
  timers.timers[0].callback();
  assert.deepEqual(map.calls.at(-1), ["camera", 14, [120.15, 30.25], true, 1600]);
  timers.timers[1].callback();
  assert.deepEqual(map.calls.at(-1), ["camera", 17, [120.14, 30.26], false, 2400]);
  playback.stop();
  assert.equal(playback.pendingTimers, 0);
  assert.equal(timers.timers[2].cleared, true);
  timers.timers[2].callback();
  assert.equal(map.calls.filter((call) => call[0] === "camera").length, 2);
});

test("reduced motion applies one still camera without scheduling animation", () => {
  const map = fakeMap();
  const timers = timerHarness();
  const playback = createDestinationCameraPlayback({
    map,
    beats: [beat("area", 120.15, 30.25, 1600), beat("place", 120.14, 30.26, 2400)],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    reducedMotion: true,
  });
  playback.start();
  assert.equal(playback.pendingTimers, 0);
  assert.equal(timers.timers.length, 0);
  assert.deepEqual(map.calls.at(-1), ["camera", 14, [120.15, 30.25], true, 1600]);
});
