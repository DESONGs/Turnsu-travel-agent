const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A pointer identifies a trip; it never carries permission or connection credentials. */
export function parseTravelPointer(text, connectedService) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 8192) throw new Error("文件过大或无法读取");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("旅行文件不是有效的 JSON"); }
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).sort().join(",") !== "formatVersion,service,tripId"
    || value.formatVersion !== 1 || typeof value.service !== "string" || typeof value.tripId !== "string" || !UUID.test(value.tripId)) {
    throw new Error("旅行文件的格式不受支持");
  }
  let service;
  try { service = new URL(value.service); } catch { throw new Error("旅行文件的服务地址无效"); }
  if (service.protocol !== "https:" || service.username || service.password || service.pathname !== "/" || service.search || service.hash
    || service.origin !== connectedService) throw new Error("这个文件属于其他旅行服务，请连接对应服务后再打开");
  return { tripId: value.tripId, service: service.origin };
}
