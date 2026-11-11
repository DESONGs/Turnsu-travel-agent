import { createHash } from "node:crypto";
import { hydrateStoredTripState } from "../../travel-agent-pi-package/src/core/index.ts";
import { stripGoogleContent } from "../../travel-agent-pi-package/src/core/provider-content.ts";
import { requireWorkspaceRole } from "../../travel-agent-pi-package/src/core/workspace.ts";

export const WORKSPACE_SQL = `
CREATE TABLE IF NOT EXISTS travel_workspace_data (
 trip_id TEXT PRIMARY KEY REFERENCES trip_states(trip_id), data_json JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS travel_workspace_photos (
 trip_id TEXT NOT NULL REFERENCES trip_states(trip_id), entry_id TEXT NOT NULL, photo_id TEXT NOT NULL,
 image_bytes BYTEA NOT NULL, PRIMARY KEY(trip_id,photo_id)
);
CREATE TABLE IF NOT EXISTS travel_workspace_commands (
 trip_id TEXT NOT NULL REFERENCES trip_states(trip_id), user_id TEXT NOT NULL, request_id TEXT NOT NULL,
 command_hash TEXT NOT NULL, action TEXT NOT NULL, entry_id TEXT, result_json JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(trip_id,user_id,request_id)
);`;
const migrations = new WeakMap();
const failure = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };

/** Formal workspace writes share the PostgreSQL trip-row lock with planning commits. */
export class WorkspaceRepository {
  constructor({ store }) { this.store = store; this.pool = store.pool; }
  async migrate() {
    if (!this.pool) failure("workspace_postgres_required", 503);
    await this.store.migrate();
    let ready = migrations.get(this.pool);
    if (!ready) {
      ready = (async () => { const db = await this.pool.connect(); try { await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(715803129)"); await db.query(WORKSPACE_SQL); await db.query("COMMIT"); } catch (error) { await db.query("ROLLBACK").catch(() => {}); migrations.delete(this.pool); throw error; } finally { db.release(); } })();
      migrations.set(this.pool, ready);
    }
    await ready;
  }
  async transaction(tripId, userId, task) {
    await this.migrate();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN"); await db.query("SET LOCAL statement_timeout='8000ms'");
      const saved = (await db.query("SELECT state_json FROM trip_states WHERE trip_id=$1 FOR UPDATE", [tripId])).rows[0];
      if (!saved) failure("trip_not_found", 404);
      const state = hydrateStoredTripState(saved.state_json);
      requireWorkspaceRole(state, userId);
      let data = (await db.query("SELECT data_json FROM travel_workspace_data WHERE trip_id=$1", [tripId])).rows[0]?.data_json;
      if (!data) {
        data = { entries: [], reviews: {} };
        // Import earlier records once. Stable IDs replace the old array indexes;
        // source bytes remain byte-for-byte identical and never enter TripState.
        const legacyExists = (await db.query("SELECT to_regclass('travel_photo_journal') AS name")).rows[0]?.name;
        if (legacyExists) {
          const old = (await db.query("SELECT record_json FROM travel_photo_journal WHERE trip_id=$1", [tripId])).rows;
          for (const { record_json: entry } of old) {
            const photos = [];
            for (const [index, photo] of (entry.photos ?? []).entries()) {
              const photoId = `photo_${createHash('sha256').update(`${tripId}:${entry.id}:${photo.id ?? index}`).digest('hex').slice(0,32)}`;
              const bytes = Buffer.from(photo.data, "base64");
              await db.query("INSERT INTO travel_workspace_photos(trip_id,entry_id,photo_id,image_bytes) VALUES($1,$2,$3,$4)", [tripId, entry.id, photoId, bytes]);
              photos.push({ photoId, index, mimeType: "image/jpeg", width: photo.width, height: photo.height, byteLength: bytes.length, relief: photo.relief ?? null });
            }
            data.entries.push({ entryId: entry.id, entryRevision: 0, title: entry.placeTitle ?? "", note: entry.note ?? "", subject: entry.subject, stage: entry.stage, takenOn: entry.takenOn ?? null, visitStopId: null, placeTitle: entry.placeTitle ?? "", photos, createdAt: entry.createdAt, updatedAt: entry.createdAt });
          }
        }
        await db.query("INSERT INTO travel_workspace_data(trip_id,data_json) VALUES($1,$2::jsonb)", [tripId, JSON.stringify(data)]);
      }
      const context = { db, state, data, changed: false, nextState: null };
      const result = await task(context);
      if (context.changed) await db.query("UPDATE travel_workspace_data SET data_json=$2::jsonb WHERE trip_id=$1", [tripId, JSON.stringify(context.data)]);
      if (context.nextState) {
        const next = hydrateStoredTripState(stripGoogleContent({ ...context.nextState, storageVersion: state.storageVersion + 1 }));
        await db.query("UPDATE trip_states SET state_json=$2::jsonb,storage_version=$3,updated_at=now() WHERE trip_id=$1", [tripId, JSON.stringify(next), next.storageVersion]);
      }
      await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
    finally { db.release(); }
  }
}
