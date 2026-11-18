import { createHash } from "node:crypto";
import { httpError } from "./http-errors.mjs";
import { validDepthShapes } from "../media/destination-painting.js";

const invalid = () => {
  throw httpError("memory_input_invalid", 400);
};
function memoryText(value) {
  if (typeof value !== "string" || value.length > 3000) invalid();
  return value.trim();
}
function memoryDate(value) {
  if (!value) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\d$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalid();
  return value;
}
function shortText(value, max) {
  if (typeof value !== "string" || value.length > max) invalid();
  return value.trim();
}

function memoryArt(artwork, sanitizeJournalJpeg) {
  if (!validDepthShapes(artwork?.shapes)) invalid();
  const jpeg = sanitizeJournalJpeg(artwork.data);
  const shapes = artwork.shapes.map(({ depth, points }) => ({ depth, points }));
  const source = shortText(artwork.source ?? "", 500);
  const digest = createHash("sha256")
    .update(jpeg.data)
    .update(JSON.stringify([shapes, source]))
    .digest("hex");
  return { id: "0", ...jpeg, shapes, source, digest };
}

export function registerTravelMemories({
  app,
  asyncRoute,
  requireJournalMember,
  travelService,
  repository,
  clock,
  sanitizeJournalJpeg,
}) {
  const base = "/api/trips/:tripId/memories";
  const route = (handler) =>
    asyncRoute(async (req, res) => {
      const { userId } = await requireJournalMember(req);
      res.set("Cache-Control", "private, no-store");
      return handler(req, res, req.params.tripId, userId);
    });
  app.get(
    base,
    route(async (req, res, trip, author) => {
      const entries = await repository.list(trip, req.query.nodeId, author);
      entries.sort(
        (a, b) =>
          (b.takenOn || b.createdAt.slice(0, 10)).localeCompare(a.takenOn || a.createdAt.slice(0, 10)) ||
          b.createdAt.localeCompare(a.createdAt),
      );
      res.json({ entries });
    }),
  );
  app.post(
    base,
    route(async (req, res, trip, authorId) => {
      const { id, nodeId, artwork } = req.body ?? {};
      if (typeof id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) invalid();
      const note = memoryText(req.body.note ?? "");
      if (!note && !artwork) invalid();
      let placeTitle = shortText(req.body.placeTitle ?? "", 150);
      if (nodeId != null) {
        if (typeof nodeId !== "string" || nodeId.length > 128) invalid();
        const plan = await travelService.getTripPlanView(trip);
        const node = [
          ...Object.values(plan.byDomain ?? {}).flat(),
          ...(plan.pendingProposals ?? []).flatMap((p) => Object.values(p.byDomain ?? {}).flat()),
        ].find((n) => n.nodeId === nodeId);
        const existing = !node && (await repository.get(trip, id, authorId));
        if (!node && existing?.nodeId !== nodeId) throw httpError("journal_node_not_found", 404);
        placeTitle = node?.title ?? existing.placeTitle;
      }
      if (!placeTitle) invalid();
      const photos = artwork ? [memoryArt(artwork, sanitizeJournalJpeg)] : [];
      const record = {
        visibility: "author_only",
        nodeId: nodeId ?? null,
        placeTitle,
        takenOn: memoryDate(req.body.takenOn),
        note,
        photos,
      };
      const result = await repository.create(trip, {
        ...record,
        authorId,
        id,
        revision: 1,
        createdAt: clock().toISOString(),
        contentHash: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
      });
      res.status(201).json(result);
    }),
  );
  app.post(
    base + "/:entryId",
    route(async (req, res, trip, author) => {
      const { revision, note, takenOn } = req.body ?? {};
      if (!Number.isSafeInteger(revision) || revision < 1) invalid();
      const text = memoryText(note);
      if (
        !text &&
        !req.body.artwork &&
        !(await repository.get(trip, req.params.entryId, author))?.photos.length
      )
        invalid();
      const fields = { note: text };
      if (req.body.artwork) fields.photos = [memoryArt(req.body.artwork, sanitizeJournalJpeg)];
      if (takenOn !== undefined) fields.takenOn = memoryDate(takenOn);
      res.json(await repository.reviseMemory(trip, req.params.entryId, author, revision, fields));
    }),
  );
  app.get(
    base + "/:entryId/art",
    route(async (req, res, trip, author) => {
      const item = await repository.get(trip, req.params.entryId, author);
      if (!item?.photos[0]) throw httpError("memory_not_found", 404);
      res
        .type("image/jpeg")
        .set("X-Content-Type-Options", "nosniff")
        .send(Buffer.from(item.photos[0].data, "base64"));
    }),
  );
  app.delete(
    base + "/:entryId",
    route(async (req, res, trip, author) => {
      await repository.delete(trip, req.params.entryId, author);
      res.status(204).end();
    }),
  );
}
