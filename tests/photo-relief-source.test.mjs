import assert from "node:assert/strict";
import test from "node:test";
import { fetchReliefSourcePhoto } from "../src/web/photo-relief-source.js";

test("selected source photos use browser CORS without credentials and retain their binary bytes", async (t) => {
  const input = new Uint8Array([255, 216, 255, 217]);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://images.example.org/photo.jpg");
    assert.equal(options.mode, "cors"); assert.equal(options.credentials, "omit"); assert.equal(options.referrerPolicy, "no-referrer");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(input, { headers: { "content-type": "image/jpeg" } });
  });
  const photo = await fetchReliefSourcePhoto("https://images.example.org/photo.jpg");
  assert.equal(photo.type, "image/jpeg"); assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), input);
});

test("source processing refuses unsafe URLs, non-images and oversize streamed bodies", async (t) => {
  for (const url of ["file:///private/a.jpg", "http://example.org/a.jpg", "https://user:secret@example.org/a.jpg", "invalid"]) await assert.rejects(fetchReliefSourcePhoto(url), /relief_source_invalid/);
  const responses = [new Response("html", { headers: { "content-type": "text/html" } }), new Response("", { headers: { "content-type": "image/jpeg", "content-length": "12000001" } }), new Response(new Uint8Array(12_000_001), { headers: { "content-type": "image/png" } })];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  await assert.rejects(fetchReliefSourcePhoto("https://images.example.org/photo.jpg"), /relief_source_unavailable/);
  await assert.rejects(fetchReliefSourcePhoto("https://images.example.org/photo.jpg"), /relief_source_too_large/);
  await assert.rejects(fetchReliefSourcePhoto("https://images.example.org/photo.jpg"), /relief_source_too_large/);
});

test("changing photos cancels the source request rather than completing an obsolete selection", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const pending = fetchReliefSourcePhoto("https://images.example.org/photo.jpg", controller.signal);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
});
