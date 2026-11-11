import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/app";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const tick = () => new Promise(resolve => setImmediate(resolve));

// Execute production host modules. Only the external host transport is a protocol double.
async function fixture() {
  const state = { actor: "owner-A", sent: [], opened: [], cleared: [], initial: [], errors: [], reads: new Map() };
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, Uint8Array, atob, setTimeout, clearTimeout });
  class ProtocolApp {
    constructor() { state.app = this; this.listeners = new Map(); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    getHostContext() { return { theme: "light", displayMode: "fullscreen" }; }
    getHostCapabilities() { return { message: {} }; }
    async connect() {}
    async callServerTool({ name, arguments: args }) {
      if (name === "get_profile") return { structuredContent: { id: state.actor } };
      if (name === "open_travel_workbench") return { structuredContent: { service: "https://travel.example.com", trip: null, workspaces: { items: [] } } };
      if (state.failure) return { isError: true, structuredContent: { code: state.failure } };
      return { structuredContent: { tripId: args.tripId, role: "owner", state: {} } };
    }
    async sendMessage(input) { state.sent.push(input); return {}; }
  }
  class ProtocolExtensions {
    constructor(app) {
      this.message = { send: input => app.sendMessage(input) };
      this.resources = { read: ({ uri }) => new Promise(resolve => state.reads.set(uri, resolve)) };
    }
  }
  const modules = new Map();
  function synthetic(values) {
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  }
  const external = {
    "@modelcontextprotocol/ext-apps": synthetic({ App: ProtocolApp }),
    "@openai/mcp-extensions/app": synthetic({ OpenAIExtensions: ProtocolExtensions, OpenAIFileEntrypointInputSchema }),
  };
  async function source(url) {
    if (modules.has(url.href)) return modules.get(url.href);
    const contents = await readFile(url, "utf8");
    const module = url.pathname.endsWith(".json")
      ? synthetic({ default: JSON.parse(contents), ...JSON.parse(contents) })
      : new vm.SourceTextModule(contents, { context, identifier: url.href });
    modules.set(url.href, module);
    if (module instanceof vm.SourceTextModule) await module.link((name, parent) => external[name] || source(new URL(name, parent.identifier)));
    return module;
  }
  const module = await source(new URL("../src/host.js", import.meta.url));
  await module.evaluate();
  state.host = module.namespace.makeHost({
    onInitial: value => state.initial.push(value), onOpenTrip: value => state.opened.push(value.tripId),
    onError: message => state.errors.push(message), onIdentityChanged: () => state.cleared.push("identity"),
    onAccessLost: () => state.cleared.push("access"),
  });
  state.input = args => {
    const event = { arguments: args };
    if (state.app.ontoolinput) state.app.ontoolinput(event);
    else state.app.listeners.get("toolinput")?.(event);
  };
  state.result = value => state.app.ontoolresult({ structuredContent: value });
  state.file = (name, tripId) => ({ uri: `file:///${name}.traveltrip`, text: JSON.stringify({ formatVersion: 1, service: "https://travel.example.com/", tripId }) });
  return state;
}

test("a connected sidebar cannot send to a chat until this trip is explicitly linked", async () => {
  const f = await fixture(); await f.host.connect();
  assert.equal(f.host.canMessage(A), false);
  await assert.rejects(() => f.host.sendMessage("continue", A));
  assert.equal(f.sent.length, 0);
  f.input({ tripId: A, instruction: "继续核对这趟旅行" }); await tick();
  assert.equal(f.host.canMessage(A), true);
  assert.equal(f.host.canMessage(B), false);
  assert.equal(await f.host.sendMessage("continue", A), "sent");
  assert.equal(f.sent.length, 1);
  f.input({}); await tick();
  assert.equal(f.host.canMessage(A), false);
});

test("connecting reads the authenticated initial list without relying on a replayed tool result", async () => {
  const f = await fixture(); await f.host.connect();
  assert.equal(f.initial.length, 1);
  assert.equal(f.initial[0].profile.id, "owner-A");
});

test("tool input received during connection opens and links the trip after identity is known", async () => {
  const f = await fixture();
  f.app.connect = async () => f.input({ tripId: A, instruction: "继续核对这趟旅行" });
  await f.host.connect();
  assert.deepEqual(f.opened, [A]);
  assert.equal(f.host.canMessage(A), true);
});

test("an account switch clears the old view before returning data under the new identity", async () => {
  const f = await fixture(); await f.host.connect();
  await f.host.call("get_profile"); f.actor = "owner-B";
  await assert.rejects(() => f.host.call("get_travel_workspace", { tripId: A }), { code: "account_changed" });
  assert.deepEqual(f.cleared, ["identity"]);
  assert.equal(f.host.canMessage(A), false);
});

test("loss of access clears displayed private data", async () => {
  const f = await fixture(); await f.host.connect(); f.failure = "trip_not_found";
  await assert.rejects(() => f.host.call("get_travel_workspace", { tripId: A }), { code: "trip_not_found" });
  assert.deepEqual(f.cleared, ["access"]);
});

test("an in-flight private result is discarded if the account changes before it arrives", async () => {
  const f = await fixture(); await f.host.connect();
  const call = f.app.callServerTool.bind(f.app);
  let release;
  f.app.callServerTool = input => input.name === "get_travel_workspace"
    ? new Promise(resolve => { release = () => resolve({ structuredContent: { tripId: A, privateData: "account A" } }); }) : call(input);
  const waiting = f.host.call("get_travel_workspace", { tripId: A });
  await tick(); assert.equal(typeof release, "function");
  f.actor = "owner-B"; release();
  await assert.rejects(waiting, { code: "account_changed" });
  assert.deepEqual(f.cleared, ["identity"]);
  assert.deepEqual(f.opened, []);
});

test("the last opened file wins even when an earlier file finishes late", async () => {
  const f = await fixture(); await f.host.connect();
  f.result({ service: "https://travel.example.com", workspaces: { items: [] }, trip: null }); await tick();
  for (const name of ["A", "B"]) f.input({ file: { name: `${name}.traveltrip`, resourceUri: `file:///${name}.traveltrip` } });
  await tick();
  f.reads.get("file:///B.traveltrip")({ contents: [f.file("B", B)] }); await tick(); await tick();
  f.reads.get("file:///A.traveltrip")({ contents: [f.file("A", A)] }); await tick(); await tick();
  assert.deepEqual(f.opened, [B]);
});

test("a file response must contain exactly the requested URI and never inherits a chat link", async () => {
  const f = await fixture(); await f.host.connect();
  f.result({ service: "https://travel.example.com", workspaces: { items: [] }, trip: null }); await tick();
  f.input({ tripId: A, instruction: "旅行 A" }); await tick();
  f.input({ file: { name: "A.traveltrip", resourceUri: "file:///A.traveltrip" } }); await tick();
  const before = f.opened.length;
  f.reads.get("file:///A.traveltrip")({ contents: [f.file("B", B)] }); await tick(); await tick();
  assert.equal(f.opened.length, before);
  assert.equal(f.host.canMessage(A), false);
  assert.ok(f.errors.length);
});
