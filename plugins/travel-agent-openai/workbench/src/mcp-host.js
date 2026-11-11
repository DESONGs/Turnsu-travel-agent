import { App } from "@modelcontextprotocol/ext-apps";
import { TravelHostPort } from "./host-port.mjs";
import { version } from "../package.json";
export function makeMcpHost(callbacks) {
  return new TravelHostPort(new App({ name: "Travel Agent", version }, {}, { autoResize: true }), callbacks);
}
