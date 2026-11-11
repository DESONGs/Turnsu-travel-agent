import { strict as assert } from "node:assert";
import { test } from "node:test";
import { draftDays } from "../src/draft-days.mjs";

test("editing a visit does not leave a later visit before an earlier one", () => {
  const later = { stopId: "later", startLocal: "2026-11-11T08:00", startAt: "2026-11-11T00:00:00Z" };
  const earlier = { stopId: "earlier", startLocal: "2026-11-11T05:00", startAt: "2026-11-10T21:00:00Z" };
  const input = [later, earlier];
  assert.deepEqual(draftDays(input).map(day => day.stops.map(stop => stop.stopId)), [["earlier", "later"]]);
  assert.deepEqual(input, [later, earlier]);
});

test("local dates can recur after crossing time zones without losing visits", () => {
  const input = [
    { stopId: "third", startLocal: "2026-11-02T03:00", startAt: "2026-11-02T03:00:00Z" },
    { stopId: "first", startLocal: "2026-11-02T10:00", startAt: "2026-11-02T01:00:00Z" },
    { stopId: "second", startLocal: "2026-11-01T18:00", startAt: "2026-11-02T02:00:00Z" },
    { stopId: "unknown" },
  ];
  assert.deepEqual(draftDays(input).map(day => [day.date, day.stops.map(stop => stop.stopId)]), [
    ["2026-11-02", ["first"]], ["2026-11-01", ["second"]], ["2026-11-02", ["third"]], ["日期待确定", ["unknown"]],
  ]);
});
