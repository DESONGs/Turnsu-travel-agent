// A reproducible, device-local photo relief. This is not a scan or a metric depth map.
export const PHOTO_RELIEF_VERSION = "photo-relief-v1";
export const canPreviewPhotoRelief = (subject) => subject === "landscape" || subject === "building";
export const defaultPhotoRelief = () => ({ version: PHOTO_RELIEF_VERSION, horizon: 0.48, depth: 0.65, style: "ink" });

export function validatePhotoRelief(value) {
  const fail = () => { throw Object.assign(new Error("journal_relief_invalid"), { code: "journal_relief_invalid", status: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (value.version !== PHOTO_RELIEF_VERSION || !["ink", "photo"].includes(value.style)) fail();
  if (!Number.isFinite(value.horizon) || value.horizon < 0.2 || value.horizon > 0.8) fail();
  if (!Number.isFinite(value.depth) || value.depth < 0.15 || value.depth > 1) fail();
  // Do not accept URLs, executable instructions, arbitrary geometry or provider settings.
  if (Object.keys(value).some((key) => !["version", "horizon", "depth", "style"].includes(key))) fail();
  return { version: PHOTO_RELIEF_VERSION, horizon: value.horizon, depth: value.depth, style: value.style };
}
