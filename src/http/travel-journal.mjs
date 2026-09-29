import { createHash } from "node:crypto";
import { httpError } from "./http-errors.mjs";
import { canPreviewPhotoRelief, validatePhotoRelief } from "../media/photo-relief-recipe.mjs";

// Canvas emits baseline JPEG. Strip all APP/COM metadata on the server too, reject
// progressive/oversized/non-JPEG payloads, and discard any trailing bytes.
export function sanitizeJournalJpeg(data) {
  const invalid = () => { throw httpError("journal_photo_invalid", 400); };
  if (typeof data !== "string" || data.length > 600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) invalid();
  const buffer = Buffer.from(data, "base64");
  if (buffer.toString("base64") !== data || buffer.length < 20 || buffer.readUInt16BE(0) !== 0xffd8) invalid();
  const parts = [buffer.subarray(0, 2)];
  let offset = 2, width = 0, height = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) invalid();
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) invalid();
    if (marker === 0xc0) {
      if (length < 11 || width) invalid();
      height = buffer.readUInt16BE(offset + 5); width = buffer.readUInt16BE(offset + 7);
      if (!width || !height || width > 1280 || height > 1280 || buffer[offset + 4] !== 8) invalid();
    } else if (![0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker) && !(marker >= 0xe0 && marker <= 0xef)) invalid();
    if (marker < 0xe0 || marker > 0xef) { if (marker !== 0xfe) parts.push(buffer.subarray(offset, end)); }
    if (marker === 0xda) {
      if (!width) invalid();
      for (let scan = end; scan < buffer.length - 1; scan++) {
        if (buffer[scan] !== 0xff) continue;
        const next = buffer[++scan];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) continue;
        if (next !== 0xd9) invalid();
        parts.push(buffer.subarray(end, scan + 1));
        const clean = Buffer.concat(parts);
        return { data: clean.toString("base64"), width, height, byteLength: clean.length, mimeType: "image/jpeg" };
      }
      invalid();
    }
    offset = end;
  }
  invalid();
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function buildJournalEntry(body, { node, clock }) {
  if (!uuid.test(body?.id ?? "") || !["landscape", "building", "food"].includes(body?.subject) || !["wish", "visited"].includes(body?.stage)) throw httpError("journal_input_invalid", 400);
  const note = body.note ?? "";
  const takenOn = body.takenOn || null;
  if (typeof note !== "string" || note.length > 1000 || (takenOn && (!/^\d{4}-\d{2}-\d{2}$/.test(takenOn) || !Number.isFinite(Date.parse(takenOn)) || new Date(takenOn).toISOString().slice(0, 10) !== takenOn))) throw httpError("journal_input_invalid", 400);
  if (!Array.isArray(body.photos) || !body.photos.length || body.photos.length > 3) throw httpError("journal_photo_limit", 400);
  const photos = body.photos.map((photo, index) => {
    if (photo?.relief != null && !canPreviewPhotoRelief(body.subject)) throw httpError("journal_relief_subject_unsupported", 400);
    const relief = photo?.relief == null ? null : validatePhotoRelief(photo.relief);
    return { id: String(index), ...sanitizeJournalJpeg(photo?.data), ...(relief ? { relief } : {}) };
  });
  const content = { nodeId: node.nodeId, subject: body.subject, stage: body.stage, note: note.trim(), takenOn, photos };
  const model = photos.some((photo) => photo.relief) ? { status: "recipe_saved", kind: "photo-relief-v1", reconstruction: false, processing: "on_device" } : { status: "not_generated" };
  return { id: body.id, ...content, placeTitle: node.title, visibility: "trip_only", model, createdAt: clock().toISOString(), contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
}

export function registerTravelJournalRoutes({ app, asyncRoute, requireTripMember, travelService, repository, clock }) {
  const base = "/api/trips/:tripId/journal";
  const requireJournalMember = async (request) => {
    const session = await requireTripMember(request, request.params.tripId);
    const state = await travelService.store.get(request.params.tripId);
    // Legacy unowned trips may be readable elsewhere, but cannot expose private photos.
    if (!state?.collaboration?.memberUserIds?.includes(session.userId)) throw httpError("trip_access_denied", 403);
  };
  app.get(base, asyncRoute(async (request, response) => {
    await requireJournalMember(request);
    response.json({ entries: await repository.list(request.params.tripId, request.query.nodeId) });
  }));
  app.post(base, asyncRoute(async (request, response) => {
    await requireJournalMember(request);
    if (!uuid.test(request.body?.id ?? "") || typeof request.body?.nodeId !== "string") throw httpError("journal_input_invalid", 400);
    const plan = await travelService.getTripPlanView(request.params.tripId);
    // Before adoption the workbench shows pending candidates, not only committed
    // nodes. A personal memory must not require accepting a travel decision.
    const candidates = [
      ...Object.values(plan.byDomain ?? {}).flat(),
      ...(plan.pendingProposals ?? []).flatMap((proposal) => Object.values(proposal.byDomain ?? {}).flat()),
    ];
    const saved = await repository.get(request.params.tripId, request.body?.id);
    const node = candidates.find((item) => item.nodeId === request.body?.nodeId)
      ?? (saved && saved.nodeId === request.body?.nodeId ? { nodeId: saved.nodeId, title: saved.placeTitle } : null);
    // A confirmed retry is still possible after the candidate disappears. The
    // repository's content hash rejects changing an existing record in place.
    if (!node) throw httpError("journal_node_not_found", 404);
    const record = buildJournalEntry(request.body, { node, clock });
    response.status(201).json(await repository.create(request.params.tripId, record));
  }));
  app.get(`${base}/:entryId/photos/:photoId`, asyncRoute(async (request, response) => {
    await requireJournalMember(request);
    const entry = await repository.get(request.params.tripId, request.params.entryId);
    const photo = entry?.photos.find((item) => item.id === request.params.photoId);
    if (!photo) throw httpError("journal_photo_not_found", 404);
    response.set({ "Content-Type": "image/jpeg", "Content-Disposition": "inline; filename=travel-photo.jpg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(photo.data, "base64"));
  }));
  app.delete(`${base}/:entryId`, asyncRoute(async (request, response) => {
    await requireJournalMember(request);
    await repository.delete(request.params.tripId, request.params.entryId);
    response.status(204).end();
  }));
}
