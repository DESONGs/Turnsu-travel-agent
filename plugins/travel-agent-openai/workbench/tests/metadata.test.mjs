import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpenAIUiToolMetadataSchema } from "@openai/mcp-extensions";

test("the three entrypoints use the official extension schema", () => {
  const metadata = { entrypoints: [{ type: "global" }, { type: "thread" }, { type: "file", extensions: [".traveltrip"] }] };
  assert.equal(OpenAIUiToolMetadataSchema.safeParse(metadata).success, true);
  assert.equal(OpenAIUiToolMetadataSchema.safeParse({ entrypoints: [{ type: "file", extensions: ["traveltrip"] }] }).success, false);
});

test("plugin manifests and the workbench identify the same version", () => {
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const version = read("../package.json").version;
  assert.equal(read("../../plugin.json").version, version);
  assert.equal(read("../../.codex-plugin/plugin.json").version, version);
});
