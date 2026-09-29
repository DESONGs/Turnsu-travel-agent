import assert from "node:assert/strict";
import test from "node:test";
import { assertCompatiblePiHost, piHostCompatibility } from "../src/agent/pi-host-compatibility.mjs";

test("Pi host compatibility enables the verified 0.85.1 release only", () => {
  assert.equal(piHostCompatibility("0.85.1").status, "compatible");
  assert.equal(piHostCompatibility("0.84.1").status, "incompatible");
  assert.equal(piHostCompatibility("0.85.2").status, "incompatible");
  assert.equal(piHostCompatibility("0.74.0").status, "incompatible");
  assert.equal(piHostCompatibility("0.85.0").status, "incompatible");
  assert.equal(piHostCompatibility("0.85.1-experimental").supported, false);
  assert.equal(piHostCompatibility("unknown").supported, false);
  assert.throws(() => assertCompatiblePiHost({ version: null, allowUnknown: false }), /unsupported_pi_host_version/);
  assert.throws(() => assertCompatiblePiHost({ version: "0.74.0", allowUnknown: false }), /unsupported_pi_host_version/);
});
