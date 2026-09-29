import { Pool } from "pg";
import { executionWrite } from "./execution-write.mjs";
import { hydrateStoredTripState } from "../../travel-agent-pi-package/src/core/index.ts";

function repositoryError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function validateState(state, expectedTripId) {
  let validated;
  try {
    validated = hydrateStoredTripState(state);
  } catch {
    throw repositoryError("invalid_stored_trip");
  }
  if (validated.tripId !== expectedTripId) throw repositoryError("invalid_stored_trip");
  return validated;
}

export const POSTGRES_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS trip_states (
  trip_id TEXT PRIMARY KEY,
  storage_version INTEGER NOT NULL CHECK (storage_version >= 0),
  state_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_states_updated_at_idx ON trip_states (updated_at DESC);
CREATE TABLE IF NOT EXISTS travel_conversations (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trip_id TEXT NULL,
  storage_version INTEGER NOT NULL CHECK (storage_version >= 0),
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS travel_conversations_user_updated_at_idx ON travel_conversations (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS evidence_presentations (
  bundle_id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  trip_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  bundle_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_presentations_trip_idx ON evidence_presentations (trip_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS evidence_presentations_expiry_idx ON evidence_presentations (expires_at);
CREATE TABLE IF NOT EXISTS travel_mobility_previews (
  preview_id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trip_states(trip_id),
  expires_at BIGINT NOT NULL, record_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS travel_mobility_previews_expiry ON travel_mobility_previews(expires_at);
`;

const migrations = new WeakMap();
export async function migrateTravelDatabase(pool) {
  let pending = migrations.get(pool);
  if (!pending) {
    pending = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(715803124)");
        await client.query(POSTGRES_MIGRATION_SQL);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); migrations.delete(pool); throw error; }
      finally { client.release(); }
    })();
    migrations.set(pool, pending);
  }
  await pending;
}

export class PostgresTripRepository {
  constructor({ databaseUrl, pool } = {}) {
    if (!pool && !databaseUrl) throw repositoryError("database_url_required");
    this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 10_000 });
    this.ownsPool = !pool;
    this.mode = "postgres";
  }

  async migrate() {
    await migrateTravelDatabase(this.pool);
  }

  async create(state) {
    await this.migrate();
    const persisted = structuredClone(state);
    persisted.storageVersion = 0;
    try {
      await executionWrite(this.pool, (db) => db.query(
        "INSERT INTO trip_states (trip_id, storage_version, state_json) VALUES ($1, $2, $3::jsonb)",
      [persisted.tripId, persisted.storageVersion, JSON.stringify(persisted)],
    ), { productWrite: true, tripId: persisted.tripId });
      return persisted;
    } catch (error) {
      if (error?.code === "23505") throw repositoryError("trip_already_exists", { tripId: persisted.tripId });
      throw error;
    }
  }

  async get(tripId) {
    const result = await this.pool.query("SELECT state_json FROM trip_states WHERE trip_id = $1", [tripId]);
    if (!result.rowCount) return null;
    return validateState(result.rows[0].state_json, tripId);
  }

  async list() {
    const result = await this.pool.query("SELECT state_json FROM trip_states ORDER BY updated_at DESC");
    return result.rows.map((row) => validateState(row.state_json, row.state_json.tripId));
  }
  async getMobilityPreview(previewId, now = Date.now()) {
    await this.migrate();
    const result = await this.pool.query("SELECT record_json FROM travel_mobility_previews WHERE preview_id=$1 AND expires_at>$2", [previewId, now]);
    return result.rows[0]?.record_json ?? null;
  }
  async saveMobilityPreview(previewId, record, expiresAt, now = Date.now()) {
    await this.migrate();
    await executionWrite(this.pool, (db) => db.query("INSERT INTO travel_mobility_previews(preview_id,trip_id,expires_at,record_json) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(preview_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,record_json=EXCLUDED.record_json WHERE travel_mobility_previews.trip_id=EXCLUDED.trip_id", [previewId, record.tripId, expiresAt, JSON.stringify(record)]));
    await this.pool.query("DELETE FROM travel_mobility_previews WHERE preview_id IN (SELECT preview_id FROM travel_mobility_previews WHERE expires_at<$1 LIMIT 64)", [now]);
  }

  async listSharedPlaceFeedback(sourceRefs) {
    const requested = [...new Set((Array.isArray(sourceRefs) ? sourceRefs : []).filter(Boolean))];
    if (!requested.length) return [];
    const result = await this.pool.query(
      `SELECT state_json->>'tripId' AS trip_id,
              COALESCE(state_json#>>'{collaboration,ownerUserId}', state_json->>'tripId') AS contributor_key,
              feedback
       FROM trip_states
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(state_json->'feedbackLedger', '[]'::jsonb)) AS feedback
       WHERE feedback->>'visibility' = 'anonymous_travelers'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(COALESCE(feedback->'place'->'sourceRefs', '[]'::jsonb)) AS source_ref(value)
           WHERE source_ref.value = ANY($1::text[])
         )`,
      [requested],
    );
    return result.rows.map((row) => ({ tripId: row.trip_id, contributorKey: row.contributor_key, feedback: row.feedback }));
  }

  async save(state, { expectedStorageVersion } = {}) {
    const persisted = structuredClone(state);
    const nextVersion = Number(expectedStorageVersion) + 1;
    persisted.storageVersion = nextVersion;
    const result = await executionWrite(this.pool, (db) => db.query(
      `UPDATE trip_states
       SET storage_version = $3, state_json = $4::jsonb, updated_at = now()
       WHERE trip_id = $1 AND storage_version = $2`,
      [persisted.tripId, expectedStorageVersion, nextVersion, JSON.stringify(persisted)],
    ), { productWrite: true, tripId: persisted.tripId });
    if (!result.rowCount) {
      const exists = await this.pool.query("SELECT 1 FROM trip_states WHERE trip_id = $1", [persisted.tripId]);
      throw repositoryError(exists.rowCount ? "storage_conflict" : "trip_not_found", { tripId: persisted.tripId });
    }
    return persisted;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
