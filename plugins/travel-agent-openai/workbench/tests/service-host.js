import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

// This bridge forwards tools and UI resources to the isolated Java/PostgreSQL fixture.
// Authentication stays in the loopback test proxy, never in a browser payload.
const context = await (await fetch("/fixture-context")).json();
const peer = new URLSearchParams(location.search).get("account") === "peer";
const frame = document.querySelector("iframe");
async function rpc(method, params) {
  const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params, peer }) });
  if (!response.ok) throw new Error("隔离服务请求失败，请检查测试进程。");
  return response.json();
}
const bridge = new AppBridge(null, { name: "Travel isolated service browser fixture", version: "1" },
  { serverTools: {}, serverResources: {}, message: {}, logging: {}, experimental: { "openai/message": {}, "openai/resource": {} } });
bridge.setHostContext({ theme: "light", displayMode: "fullscreen", availableDisplayModes: ["fullscreen"] });
bridge.oncalltool = ({ name, arguments: args }) => rpc("tools/call", { name, arguments: args || {} });
bridge.onreadresource = params => rpc("resources/read", params);
bridge.onmessage = async () => ({ isError: true });
bridge.oninitialized = () => bridge.sendToolInput({ arguments: { tripId: context.tripId } });
for (const [id, action] of [["baseline", "baseline"], ["rain", "rain"]]) document.querySelector("#" + id).onclick = async () => {
  const status = document.querySelector("#control-status"); status.textContent = "正在执行隔离天气检查…";
  try {
    const response = await fetch("/fixture-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    if (!response.ok) throw new Error("请先采用暂定行程，并保持后端测试进程运行。");
    status.textContent = action === "rain" ? "隔离天气变化已保存" : "隔离天气基准已保存";
  } catch (failure) { status.textContent = failure.message; }
};
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = "/app.html";
