import { httpError } from "./http-errors.mjs";
import { validDepthShapes } from "../media/destination-painting.js";

// Only generated file references and silhouettes cross between host turns.
// The source photograph goes directly to the user's host, never into TripState.
export function registerDestinationArtwork({ app, asyncRoute, requireTripMember, clock }) {
  const tickets = new Map();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const base = "/api/trips/:tripId/artwork/:requestId";
  async function owner(req, res) {
    const { userId } = await requireTripMember(req, req.params.tripId);
    res.set("Cache-Control", "private, no-store");
    if (!uuid.test(req.params.requestId)) throw httpError("artwork_request_invalid", 400);
    const now = clock().getTime();
    for (const [key, item] of tickets) if (item.expires <= now) tickets.delete(key);
    return JSON.stringify([userId, req.params.tripId, req.params.requestId]);
  }
  app.post(base, asyncRoute(async (req, res) => {
    const key = await owner(req, res);
    if (!tickets.has(key)) {
      if (tickets.size >= 1000) throw httpError("artwork_busy", 429);
      tickets.set(key, { expires: clock().getTime() + 10 * 60_000, result: null });
    }
    res.json({ status: "pending" });
  }));
  app.get(base, asyncRoute(async (req, res) => {
    const item = tickets.get(await owner(req, res));
    if (!item) throw httpError("artwork_request_expired", 404);
    res.json(item.result ?? { status: "pending" });
  }));
  app.post(base + "/complete", asyncRoute(async (req, res) => {
    const item = tickets.get(await owner(req, res));
    if (!item) throw httpError("artwork_request_expired", 404);
    const { fileId, shapes, unavailable } = req.body ?? {};
    if (unavailable !== true && (!(typeof fileId === "string" && /^[a-zA-Z0-9_-]{1,180}$/.test(fileId)) || !validDepthShapes(shapes))) throw httpError("artwork_result_invalid", 400);
    const result = unavailable === true ? { status: "unavailable" } : { status: "ready", fileId, shapes };
    if (item.result && JSON.stringify(item.result) !== JSON.stringify(result)) throw httpError("artwork_already_completed", 409);
    item.result = result;
    res.json({ status: result.status });
  }));
  app.delete(base, asyncRoute(async (req, res) => { tickets.delete(await owner(req, res)); res.json({ status: "closed" }); }));
}
