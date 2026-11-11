/** Shared transport permissions; safe to import in hosts and browser protocol harnesses. */
export const workspaceReadActions = new Set(["get_trip_workspace_access", "list_trip_journal", "get_trip_journal_entry", "read_trip_journal_image", "list_trip_share_members", "resolve_trip_share_email", "get_trip_review"]);
export const workspaceWriteActions = new Set(["save_trip_journal_entry", "save_trip_photo_relief", "delete_trip_journal", "grant_trip_share_email", "grant_trip_access", "revoke_trip_access", "save_trip_review_condition", "adopt_trip_reviewed_draft"]);
export const workspaceActions = new Set([...workspaceReadActions, ...workspaceWriteActions]);
