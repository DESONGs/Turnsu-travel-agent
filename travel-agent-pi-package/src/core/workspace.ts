import { createHash } from "node:crypto";
import type { TripState } from "../contracts/index.js";

export type WorkspaceRole = "owner" | "editor" | "viewer";
export interface JournalPhoto { photoId: string; index: number; width: number; height: number; byteLength: number; mimeType: "image/jpeg"; relief: Record<string, unknown> | null }
export interface JournalRecord { entryId: string; entryRevision: number; title: string; note: string; subject: "landscape" | "building" | "food"; stage: "wish" | "visited"; takenOn: string | null; visitStopId: string | null; placeTitle: string; createdAt: string; updatedAt: string; photos: JournalPhoto[] }
export { workspaceReadActions, workspaceWriteActions, workspaceActions } from "./workspace-actions.js";
export const workspaceFailure = (code: string, status = 400): never => { throw Object.assign(new Error(code), { code, status }); };
export function workspaceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return workspaceFailure("workspace_input_invalid");
  return value as Record<string, unknown>;
}
export function workspaceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return workspaceFailure("workspace_id_invalid");
  return value;
}
export function workspaceVersion(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return workspaceFailure("workspace_version_required");
  return value;
}
export function workspaceRole(state: TripState, userId: string): WorkspaceRole | null {
  const access = state.collaboration;
  if (!access?.memberUserIds.includes(userId)) return null;
  return access.ownerUserId === userId ? "owner" : access.roles?.[userId] ?? "editor";
}
export function requireWorkspaceRole(state: TripState, userId: string, { write = false, owner = false }: { write?: boolean; owner?: boolean } = {}): WorkspaceRole {
  const role = workspaceRole(state, userId);
  if (!role) return workspaceFailure("trip_access_denied", 403);
  if (owner && role !== "owner") return workspaceFailure("trip_owner_required", 403);
  if (write && role === "viewer") return workspaceFailure("trip_read_only", 403);
  return role;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const workspaceFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const text = (value: unknown, max: number): string => {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) return workspaceFailure("journal_input_invalid");
  return value.trim();
};
export function normalizeJournalRecord(input: Record<string, unknown>, previous: JournalRecord | null, photos: JournalPhoto[], now: string): JournalRecord {
  const entryId = workspaceId(input.entryId), expected = workspaceVersion(input.expectedEntryRevision, -1);
  if (previous ? previous.entryRevision !== expected : expected !== -1) return workspaceFailure("journal_revision_conflict", 409);
  const title = text(input.title, 160), note = text(input.note, 4000);
  if (!title && !note && !photos.length) return workspaceFailure("journal_content_required");
  if (photos.length > 3 || new Set(photos.map(photo => photo.photoId)).size !== photos.length) return workspaceFailure("journal_photo_limit");
  if (!["landscape", "building", "food"].includes(String(input.subject)) || !["wish", "visited"].includes(String(input.stage))) return workspaceFailure("journal_input_invalid");
  if (input.subject === "food" && photos.some(photo => photo.relief)) return workspaceFailure("journal_relief_subject_unsupported");
  const date = input.takenOn == null || input.takenOn === "" ? null : text(input.takenOn, 10);
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) return workspaceFailure("journal_input_invalid");
  return { entryId, entryRevision: previous ? previous.entryRevision + 1 : 0, title, note, subject: input.subject as JournalRecord["subject"], stage: input.stage as JournalRecord["stage"], takenOn: date,
    visitStopId: input.visitStopId ? workspaceId(input.visitStopId) : null, placeTitle: previous?.placeTitle ?? "", photos,
    createdAt: previous?.createdAt ?? now, updatedAt: now };
}
export function changeWorkspaceAccess(state: TripState, actorId: string, input: Record<string, unknown>, revoke: boolean): TripState {
  requireWorkspaceRole(state, actorId, { owner: true });
  const access = state.collaboration!;
  if (workspaceVersion(input.expectedAccessRevision) !== (access.accessRevision ?? 0)) return workspaceFailure("access_revision_conflict", 409);
  const accountId = workspaceId(input.accountId);
  if (accountId === access.ownerUserId) return workspaceFailure("owner_access_protected", 409);
  if (!revoke && !["viewer", "editor"].includes(String(input.role))) return workspaceFailure("share_role_invalid");
  const next = structuredClone(state), roles = { ...access.roles };
  if (revoke) delete roles[accountId]; else roles[accountId] = input.role as "viewer" | "editor";
  next.collaboration = { ...access, roles, accessRevision: (access.accessRevision ?? 0) + 1,
    memberUserIds: revoke ? access.memberUserIds.filter(id => id !== accountId) : [...new Set([...access.memberUserIds, accountId])] };
  return next;
}
