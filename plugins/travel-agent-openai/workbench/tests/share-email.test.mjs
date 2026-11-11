import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeShareEmail, shareEmailDigest } from "../src/share-email.mjs";

test("sharing lookup sends the normalized digest rather than the address", async () => {
  assert.equal(normalizeShareEmail("  Alice@Example.Com  "), "Alice@example.com");
  assert.equal(await shareEmailDigest("  Alice@Example.Com  "), "539e5c2f3b81aac3c44fbf3e673ca72ff1cb00a039b918bd1c6bacadc9c30cad");
  assert.notEqual(await shareEmailDigest("Alice@example.com"), await shareEmailDigest("alice@example.com"));
  assert.equal(normalizeShareEmail("Alice@Gmail.Com"), "alice@gmail.com");
  assert.equal(await shareEmailDigest("Alice@Gmail.Com"), "8f5f36be822b28d9490150187df73c3b4f5e908006a1ffe25066a33e4b1a415e");
  assert.notEqual(normalizeShareEmail("é@example.com"), normalizeShareEmail("e\u0301@example.com"));
  assert.throws(() => normalizeShareEmail("a@example.com\nother@example.com"));
});
