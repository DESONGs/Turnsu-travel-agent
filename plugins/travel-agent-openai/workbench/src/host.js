import { App } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/app";
import { TravelHostPort } from "./host-port.mjs";
import { parseTravelPointer } from "./pointer.mjs";
import { version } from "../package.json";

class OpenAITravelHost extends TravelHostPort {
  constructor(app, callbacks) {
    super(app, callbacks);
    this.openTool = "open_travel_workbench";
    this.extensions = new OpenAIExtensions(app);
    this.messageAvailable = () => this.extensions.message != null;
    this.sender = input => this.extensions.message.send({ ...input, _meta: { "openai/message": { target: "active", send: true } } });
  }
  async receive(args, intent) {
    if (!args.file) return super.receive(args, intent);
    const parsed = OpenAIFileEntrypointInputSchema.safeParse(args);
    if (!parsed.success) throw new Error("当前宿主传入的旅行文件无法读取。");
    if (!this.extensions.resources) throw new Error("当前宿主不支持读取旅行文件。");
    const uri = parsed.data.file.resourceUri;
    const resource = await this.extensions.resources.read({ uri });
    if (intent !== this.intent) return;
    const matches = resource.contents?.filter(item => item.uri === uri);
    if (matches?.length !== 1) throw new Error("宿主没有返回唯一匹配的旅行文件。");
    const content = matches[0]; let text;
    if (typeof content.text === "string") text = content.text;
    else if (typeof content.blob === "string" && content.blob.length <= 11000)
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(content.blob), character => character.charCodeAt(0)));
    else throw new Error("无法读取旅行文件。");
    const pointer = parseTravelPointer(text, this.service);
    const trip = await this.call("get_travel_workspace", { tripId: pointer.tripId });
    if (intent === this.intent) this.callbacks.onOpenTrip(trip);
  }
}
export function makeHost(callbacks) {
  return new OpenAITravelHost(new App({ name: "Travel Agent", version }, {}, { autoResize: true }), callbacks);
}
