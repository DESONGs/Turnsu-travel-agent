import test from "node:test";
import assert from "node:assert/strict";
import { localDateTime, zonedIso, convertMoney, providerCoversRegion } from "../travel-agent-pi-package/src/core/global-travel.ts";
import { coordinatesForWebMap } from "../src/web/map-coordinates.js";

test("overseas map coordinates must identify their coordinate system", () => {
  assert.equal(coordinatesForWebMap({ longitude: 139.7, latitude: 35.6 }), null);
  assert.deepEqual(coordinatesForWebMap({ longitude: 139.7, latitude: 35.6, coordinateSystem: "WGS-84" }), { longitude: 139.7, latitude: 35.6 });
});
test("local schedules handle Tokyo, New York DST and the date line", () => {
  assert.equal(localDateTime("10:00", "2027-01-12", "Asia/Tokyo"), "2027-01-12T10:00:00+09:00");
  assert.equal(localDateTime("02:30", "2027-03-14", "America/New_York"), null);
  assert.equal(localDateTime("01:30", "2027-11-07", "America/New_York"), null);
  assert.equal(localDateTime("2027-11-07T01:30:00-05:00", null, "America/New_York"), "2027-11-07T01:30:00-05:00");
  assert.equal(zonedIso("2027-01-12T23:00:00Z", "Pacific/Auckland").slice(0, 10), "2027-01-13");
});
test("foreign prices cannot be added without a sourced conversion", () => {
  assert.equal(convertMoney({ amount: 1000, currency: "JPY" }, "USD"), null);
  assert.equal(convertMoney({ amount: 1000, currency: "JPY" }, "USD", [{ from: "JPY", to: "USD", rate: 0.007, source: "ecb", asOf: "2026-10-26" }]).amount, 7);
  assert.equal(providerCoversRegion({ regions: ["CN"] }, "JP"), false);
  assert.equal(providerCoversRegion({ regions: ["international"] }, null), false);
});
