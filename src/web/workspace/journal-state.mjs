export const journalTitle = item => item?.title?.trim() || item?.placeTitle?.trim() || "未命名记录";
export const sameRelief = (a, b) => Boolean(a && b && a.version === b.version && a.style === b.style && a.horizon === b.horizon && a.depth === b.depth);
export const newJournalDraft = (context = {}) => ({ entryId: crypto.randomUUID(), expectedEntryRevision: -1, title: context.name || "", note: "",
  subject: context.domain === "food" ? "food" : context.domain === "stay" ? "building" : "landscape", stage: "visited",
  takenOn: context.date || "", visitStopId: context.stopId || "", photos: [] });
export const editJournalDraft = item => ({ entryId: item.entryId, expectedEntryRevision: item.entryRevision,
  title: item.title || item.placeTitle || "", note: item.note || "", subject: item.subject, stage: item.stage,
  takenOn: item.takenOn || "", visitStopId: item.visitStopId || "", photos: item.photos.map(photo => ({ ...photo })) });
export const journalSaveArguments = (tripId, revision, draft, requestId) => ({ tripId, expectedRevision: revision, requestId,
  entryId: draft.entryId, expectedEntryRevision: draft.expectedEntryRevision, title: draft.title.trim(), note: draft.note.trim(),
  subject: draft.subject, stage: draft.stage, ...(draft.takenOn ? { takenOn: draft.takenOn } : {}), ...(draft.visitStopId ? { visitStopId: draft.visitStopId } : {}),
  photos: draft.photos.map(photo => ({ photoId: photo.photoId, ...(photo.data ? { data: photo.data } : {}),
    ...(draft.subject === "food" ? { relief: null } : photo.relief ? { relief: photo.relief } : {}) })) });
