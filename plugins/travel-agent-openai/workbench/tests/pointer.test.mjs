import test from "node:test";
import assert from "node:assert/strict";
import { parseTravelPointer } from "../src/pointer.mjs";

const valid = { formatVersion: 1, service: "https://travel.example.com", tripId: "a187f077-230c-4420-8958-241be3904350" };

test("a cloud pointer opens only on the connected service", () => {
  assert.deepEqual(parseTravelPointer(JSON.stringify(valid), valid.service), { tripId: valid.tripId, service: valid.service });
  assert.throws(() => parseTravelPointer(JSON.stringify({ ...valid, service: "https://other.example" }), valid.service));
  assert.throws(() => parseTravelPointer(JSON.stringify({ ...valid, service: "https://travel.example.com/path" }), valid.service));
  assert.throws(() => parseTravelPointer(JSON.stringify({ ...valid, token: "credential" }), valid.service));
  assert.throws(() => parseTravelPointer(JSON.stringify({ ...valid, tripId: "not-a-uuid" }), valid.service));
  assert.throws(() => parseTravelPointer("x".repeat(8193), valid.service));
});
