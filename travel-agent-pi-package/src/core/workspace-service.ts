import type { TripState } from "../contracts/index.js";
import { changeWorkspaceAccess, normalizeJournalRecord, requireWorkspaceRole, workspaceActions, workspaceFailure, workspaceFingerprint, workspaceId, workspaceObject, workspaceReadActions, workspaceVersion } from "./workspace.js";
import type { JournalPhoto, JournalRecord } from "./workspace.js";
import { buildDraftReview, reviewProgress } from "./workspace-review.js";

interface QueryResult<Row> { rows: Row[]; rowCount: number | null }
interface Database { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> }
export interface WorkspaceData { entries: JournalRecord[]; reviews: Record<string, unknown> }
export interface WorkspaceTransaction { db: Database; state: TripState; data: WorkspaceData; changed: boolean; nextState: TripState | null }
export interface WorkspaceStorage { transaction<T>(tripId: string, userId: string, task: (context: WorkspaceTransaction) => Promise<T>): Promise<T> }
type Image = { data: string; width: number; height: number; byteLength: number; mimeType: "image/jpeg" };
interface Options { repository: WorkspaceStorage; clock?: () => Date; sanitizeImage: (value: unknown) => Image; validateRelief: (value: unknown) => Record<string, unknown>; readPreview?: (id: string) => Promise<unknown>; previewFingerprint?: (state: TripState) => string }
const sharing = new Set(["list_trip_share_members", "resolve_trip_share_email", "grant_trip_share_email", "grant_trip_access", "revoke_trip_access"]);

export class WorkspaceService {
  private readonly repository: WorkspaceStorage;
  private readonly clock: () => Date;
  private readonly sanitizeImage: Options["sanitizeImage"];
  private readonly validateRelief: Options["validateRelief"];
  private readonly readPreview: (id: string) => Promise<unknown>;
  private readonly previewFingerprint: (state: TripState) => string;
  constructor({ repository, clock = () => new Date(), sanitizeImage, validateRelief, readPreview = async () => workspaceFailure("review_context_required", 409), previewFingerprint = workspaceFingerprint }: Options) { this.repository = repository; this.clock = clock; this.sanitizeImage = sanitizeImage; this.validateRelief = validateRelief; this.readPreview = readPreview; this.previewFingerprint = previewFingerprint; }

  async execute(action: string, input: Record<string, unknown>, userId: string): Promise<Record<string, unknown>> {
    if (!workspaceActions.has(action)) return workspaceFailure("workspace_operation_not_allowed", 404);
    const tripId = workspaceId(input.tripId), write = !workspaceReadActions.has(action);
    const reviewing = ["get_trip_review", "save_trip_review_condition", "adopt_trip_reviewed_draft"].includes(action);
    const cache = reviewing ? await this.readPreview(workspaceId(input.previewId)) : null;
    return this.repository.transaction(tripId, userId, async context => {
      const { db, state, data } = context;
      const role = requireWorkspaceRole(state, userId, { write, owner: sharing.has(action) });
      if (state.collaboration?.accessMode === "guest" && state.collaboration.guestExpiresAt && Date.parse(state.collaboration.guestExpiresAt) <= this.clock().getTime()) return workspaceFailure("guest_trip_expired", 403);
      if (sharing.has(action) && state.collaboration?.accessMode === "guest") return workspaceFailure("account_login_required", 403);
      if (action === "get_trip_workspace_access") return { role, revision: state.revision, accessRevision: state.collaboration?.accessRevision ?? 0 };
      if (action === "list_trip_journal") return { items: [...data.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.entryId.localeCompare(b.entryId)) };
      const entryId = input.entryId ? workspaceId(input.entryId) : null;
      const current = entryId ? data.entries.find(item => item.entryId === entryId) ?? null : null;
      if (action === "get_trip_journal_entry") { if (!current) return workspaceFailure("journal_entry_not_found", 404); return { entry: current }; }
      if (action === "read_trip_journal_image") {
        const photoId = workspaceId(input.photoId);
        if (!current?.photos.some(photo => photo.photoId === photoId)) return workspaceFailure("journal_photo_not_found", 404);
        const image = (await db.query<{ image_bytes: Buffer }>("SELECT image_bytes FROM travel_workspace_photos WHERE trip_id=$1 AND entry_id=$2 AND photo_id=$3", [tripId, entryId, photoId])).rows[0];
        if (!image) return workspaceFailure("journal_photo_not_found", 404);
        return { mimeType: "image/jpeg", data: image.image_bytes.toString("base64") };
      }
      if (action === "list_trip_share_members") {
        const ids = (state.collaboration?.memberUserIds ?? []).filter(id => id !== state.collaboration?.ownerUserId).sort();
        const after = input.cursor ? workspaceId(input.cursor) : "", page = ids.filter(id => id > after).slice(0, 50);
        const people = page.length ? (await db.query<{ user_id: string; display_name: string | null }>("SELECT user_id,display_name FROM travel_auth_users WHERE user_id=ANY($1::text[])", [page])).rows : [];
        return { items: page.map(accountId => ({ accountId, name: people.find(person => person.user_id === accountId)?.display_name || "同行人", role: state.collaboration?.roles?.[accountId] ?? "editor" })), accessRevision: state.collaboration?.accessRevision ?? 0, nextCursor: ids.filter(id => id > after).length > page.length ? page.at(-1) : null };
      }
      if (action === "resolve_trip_share_email") return { ...await this.resolveEmail(db, input.emailHash), accessRevision: state.collaboration?.accessRevision ?? 0 };
      if (reviewing) return this.review(action, input, userId, cache, context);
      const requestId = workspaceId(input.requestId), commandHash = workspaceFingerprint({ action, input });
      const receipt = (await db.query<{ command_hash: string; result_json: Record<string, unknown>; entry_id: string | null }>("SELECT command_hash,result_json,entry_id FROM travel_workspace_commands WHERE trip_id=$1 AND user_id=$2 AND request_id=$3", [tripId, userId, requestId])).rows[0];
      if (receipt) {
        if (receipt.command_hash !== commandHash) return workspaceFailure("request_id_conflict", 409);
        if (receipt.entry_id && action !== "delete_trip_journal") { const latest = data.entries.find(entry => entry.entryId === receipt.entry_id); return latest ? { ...receipt.result_json, entry: latest } : { status: "deleted", entry: null }; }
        if (action === "revoke_trip_access") return { ...receipt.result_json, revoked: !state.collaboration?.memberUserIds.includes(String(input.accountId)) };
        if (sharing.has(action)) return { ...receipt.result_json, role: state.collaboration?.roles?.[String(input.accountId)] ?? null };
        return receipt.result_json;
      }
      let result: Record<string, unknown>;
      if (sharing.has(action)) {
        if (action === "grant_trip_share_email") { const person = await this.resolveEmail(db, input.emailHash); if (person.accountId !== input.accountId) return workspaceFailure("share_account_changed", 409); }
        else if (action !== "revoke_trip_access") {
          if (!state.collaboration?.memberUserIds.includes(String(input.accountId))) return workspaceFailure("share_account_unavailable", 404);
        }
        const next = changeWorkspaceAccess(state, userId, input, action === "revoke_trip_access");
        context.nextState = next;
        if (action === "revoke_trip_access") await this.stopRevokedWatches(db, tripId, workspaceId(input.accountId));
        result = { role: action === "revoke_trip_access" ? null : input.role, revoked: action === "revoke_trip_access", accessRevision: next.collaboration!.accessRevision };
      } else {
        if (workspaceVersion(input.expectedRevision) !== state.revision) return workspaceFailure("revision_conflict", 409);
        if (!entryId) return workspaceFailure("journal_input_invalid");
        if (action === "save_trip_journal_entry") {
          if (!current && data.entries.length >= 40) return workspaceFailure("journal_trip_limit", 413);
          const deleted = (await db.query("SELECT 1 FROM travel_workspace_commands WHERE trip_id=$1 AND entry_id=$2 AND action='delete_trip_journal' LIMIT 1", [tripId, entryId])).rowCount;
          if (deleted) return workspaceFailure("journal_entry_not_found", 409);
          if (!Array.isArray(input.photos) || input.photos.length > 3) return workspaceFailure("journal_photo_limit");
          const photos: JournalPhoto[] = [];
          for (const [index, item] of input.photos.entries()) {
            const photo = workspaceObject(item), photoId = workspaceId(photo.photoId), previous = current?.photos.find(value => value.photoId === photoId);
            const relief = photo.relief == null ? null : this.validateRelief(photo.relief);
            if (photo.data != null) {
              if (previous) return workspaceFailure("journal_original_protected", 409);
              const image = this.sanitizeImage(photo.data);
              const oldPhoto = (await db.query("SELECT 1 FROM travel_workspace_photos WHERE trip_id=$1 AND photo_id=$2", [tripId, photoId])).rowCount;
              if (oldPhoto) return workspaceFailure("journal_photo_identity_conflict", 409);
              await db.query("INSERT INTO travel_workspace_photos(trip_id,entry_id,photo_id,image_bytes) VALUES($1,$2,$3,$4)", [tripId, entryId, photoId, Buffer.from(image.data, "base64")]);
              photos.push({ photoId, index, width: image.width, height: image.height, byteLength: image.byteLength, mimeType: "image/jpeg", relief });
            } else { if (!previous) return workspaceFailure("journal_photo_not_found", 404); photos.push({ ...previous, index, relief }); }
          }
          const entry = normalizeJournalRecord(input, current, photos, this.clock().toISOString());
          if (entry.visitStopId && entry.visitStopId !== current?.visitStopId) {
            const known = [state.planning?.draft, state.planning?.adopted].some(document => document?.plan?.days.some(day => day.stops.some(stop => stop.stopId === entry.visitStopId)) || document?.itinerary?.stops.some(stop => stop.stopId === entry.visitStopId))
              || state.environment?.mobility?.itinerary?.stops.some(stop => stop.stopId === entry.visitStopId);
            if (!known) return workspaceFailure("journal_visit_not_found", 409);
          }
          data.entries = [entry, ...data.entries.filter(item => item.entryId !== entryId)]; context.changed = true;
          await db.query("DELETE FROM travel_workspace_photos WHERE trip_id=$1 AND entry_id=$2 AND NOT(photo_id=ANY($3::text[]))", [tripId, entryId, photos.map(photo => photo.photoId)]);
          result = { status: "saved", entry, appliedEntryRevision: entry.entryRevision };
        } else {
          if (!current) return workspaceFailure("journal_entry_not_found", 404);
          if (workspaceVersion(input.expectedEntryRevision) !== current.entryRevision) return workspaceFailure("journal_revision_conflict", 409);
          if (action === "save_trip_photo_relief") {
            const photoId = workspaceId(input.photoId);
            if (current.subject === "food") return workspaceFailure("journal_relief_subject_unsupported");
            if (!current.photos.some(photo => photo.photoId === photoId)) return workspaceFailure("journal_photo_not_found", 404);
            const relief = this.validateRelief(input.relief);
            const entry = { ...current, entryRevision: current.entryRevision + 1, updatedAt: this.clock().toISOString(), photos: current.photos.map(photo => photo.photoId === photoId ? { ...photo, relief } : photo) };
            data.entries = data.entries.map(item => item.entryId === entryId ? entry : item); context.changed = true;
            result = { status: "saved", entry, appliedEntryRevision: entry.entryRevision };
          } else if (action === "delete_trip_journal") {
            data.entries = data.entries.filter(item => item.entryId !== entryId); context.changed = true;
            await db.query("DELETE FROM travel_workspace_photos WHERE trip_id=$1 AND entry_id=$2", [tripId, entryId]); result = { status: "deleted" };
          } else return workspaceFailure("workspace_operation_not_allowed", 404);
        }
      }
      await db.query("INSERT INTO travel_workspace_commands(trip_id,user_id,request_id,command_hash,action,entry_id,result_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", [tripId, userId, requestId, commandHash, action, entryId, JSON.stringify(result)]);
      return result;
    });
  }
  private async review(action: string, input: Record<string, unknown>, userId: string, cache: unknown, context: WorkspaceTransaction): Promise<Record<string, unknown>> {
    const { db, state, data } = context, tripId = state.tripId;
    const progress = reviewProgress(data.reviews[userId]);
    const build = () => { if (!cache) return workspaceFailure("review_preview_stale", 409); return buildDraftReview(state, cache, input, progress, this.clock(), this.previewFingerprint); };
    if (action === "get_trip_review") return { ...build().view };
    const requestId = workspaceId(input.requestId), hash = workspaceFingerprint({ action, input });
    const receipt = (await db.query<{ command_hash: string; result_json: Record<string, unknown> }>("SELECT command_hash,result_json FROM travel_workspace_commands WHERE trip_id=$1 AND user_id=$2 AND request_id=$3", [tripId, userId, requestId])).rows[0];
    if (receipt) {
      if (receipt.command_hash !== hash) return workspaceFailure("request_id_conflict", 409);
      return action === "adopt_trip_reviewed_draft" ? { ...receipt.result_json, currentRevision: state.revision } : { ...build().view };
    }
    if (workspaceVersion(input.expectedRevision) !== state.revision) return workspaceFailure("revision_conflict", 409);
    const review = build();
    if (workspaceVersion(input.expectedProgressVersion) !== progress.version) return workspaceFailure("review_progress_conflict", 409);
    let result: Record<string, unknown>;
    if (action === "save_trip_review_condition") {
      const condition = review.view.conditions.find(item => item.conditionId === input.conditionId);
      if (!condition || condition.basisHash !== input.basisHash || typeof input.acknowledged !== "boolean") return workspaceFailure("review_condition_changed", 409);
      progress.items[condition.conditionId] = { basisHash: condition.basisHash, acknowledged: input.acknowledged }; progress.version++;
      data.reviews[userId] = progress; context.changed = true; result = { ...build().view };
    } else {
      if (review.view.blockers.length || !review.proposed) return workspaceFailure("review_blocked", 409);
      if (!review.view.canAdopt) return workspaceFailure("review_confirmation_required", 409);
      context.nextState = review.proposed;
      result = { status: "committed", tripId, revision: review.proposed.revision, adoptionStatus: review.view.adoptionStatus, unverifiedConditionCount: review.view.conditions.length };
    }
    await db.query("INSERT INTO travel_workspace_commands(trip_id,user_id,request_id,command_hash,action,entry_id,result_json) VALUES($1,$2,$3,$4,$5,NULL,$6::jsonb)", [tripId, userId, requestId, hash, action, JSON.stringify(result)]);
    return result;
  }
  private async stopRevokedWatches(db: Database, tripId: string, userId: string): Promise<void> {
    const present = (await db.query<{ name: string | null }>("SELECT to_regclass('travel_price_watches') AS name")).rows[0]?.name;
    if (!present) return;
    await db.query("UPDATE travel_price_watches SET status='paused',version=version+1,fence=fence+1,worker_id=NULL,lease_until=0,last_error='trip_access_revoked' WHERE user_id=$1 AND definition_json::jsonb->>'tripId'=$2 AND status IN ('active','paused')", [userId, tripId]);
    await db.query("UPDATE travel_email_outbox SET status='cancelled' WHERE user_id=$1 AND status='pending' AND event_key IN (SELECT n.event_key FROM travel_notifications n JOIN travel_price_watches w ON w.watch_id=n.watch_id WHERE n.user_id=$1 AND w.definition_json::jsonb->>'tripId'=$2)", [userId, tripId]);
  }
  private async resolveEmail(db: Database, value: unknown): Promise<{ accountId: string; name: string; emailAuthoritative: boolean }> {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return workspaceFailure("share_email_invalid");
    const rows = (await db.query<{ user_id: string; display_name: string | null; email_authoritative: number }>("SELECT p.user_id,u.display_name,p.email_authoritative FROM travel_google_profiles p JOIN travel_auth_users u ON p.user_id=u.user_id WHERE p.email_hash=$1 FOR SHARE OF p", [value])).rows;
    if (new Set(rows.map(row => row.user_id)).size !== 1 || !rows[0]) return workspaceFailure("share_account_unavailable", 404);
    return { accountId: rows[0].user_id, name: rows[0].display_name || "Google 账号", emailAuthoritative: rows.some(row => Boolean(row.email_authoritative)) };
  }
}
