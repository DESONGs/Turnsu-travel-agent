import { createGoogleMapsProvider } from "../providers/google-maps.mjs";
import { httpError } from "./http-errors.mjs";

export function registerGoogleMapRoutes({ app, asyncRoute, requireSession, env, google }) {
  const provider = google ?? createGoogleMapsProvider(env);
  app.get("/api/maps/config", asyncRoute(async (request, response) => {
    await requireSession(request);
    response.json({ google: { status: provider.status, browserKey: provider.status === "configured" ? env.GOOGLE_MAPS_BROWSER_KEY ?? null : null, tilesAvailable: provider.status === "configured" },
      defaultCountryCode: null });
  }));
  app.get("/api/maps/google/places/:placeId", asyncRoute(async (request, response) => {
    await requireSession(request);
    response.json(await provider.placeDetails(request.params.placeId));
  }));
  app.post("/api/maps/google/tiles", asyncRoute(async (request, response) => {
    await requireSession(request);
    const { tiles, language, region, viewport } = request.body ?? {};
    if (!/^[a-zA-Z-]{2,16}$/.test(language ?? "en") || !/^[A-Z]{2}$/.test(region ?? "US") || !viewport || !["north", "south", "east", "west", "zoom"].every(key => Number.isFinite(viewport[key]))) throw httpError("invalid_google_map_viewport", 400);
    response.json(await provider.tiles({ tiles, language, region, viewport }));
  }));
  app.post("/api/maps/google/photo", asyncRoute(async (request, response) => {
    await requireSession(request);
    const name = request.body?.name;
    if (typeof name !== "string" || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]{1,3000}$/.test(name)) throw httpError("invalid_google_photo_reference", 400);
    const photo = await provider.request(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=800&skipHttpRedirect=true`);
    const url = new URL(photo.photoUri);
    if (url.protocol !== "https:" || !["googleusercontent.com", "ggpht.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw httpError("google_photo_host_not_allowed", 502);
    const source = await provider.fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!source.ok || !/^image\/(jpeg|png|webp)/.test(source.headers.get("content-type") ?? "")) throw httpError("google_photo_unavailable", 502);
    const bytes = Buffer.from(await source.arrayBuffer()); if (bytes.length > 5_000_000) throw httpError("google_photo_too_large", 413);
    response.json({ data: bytes.toString("base64"), mimeType: source.headers.get("content-type"), attribution: "Google Maps" });
  }));
}
