import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const migration = `CREATE TABLE IF NOT EXISTS travel_photo_journal (
  trip_id TEXT NOT NULL, entry_id TEXT NOT NULL, record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (trip_id, entry_id)
);`;
const metadataProjection = `record_json - 'photos' || jsonb_build_object('photos',
  (SELECT jsonb_agg(photo - 'data') FROM jsonb_array_elements(record_json->'photos') photo))`;
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
export const journalSummary = ({ photos, contentHash, ...record }) => ({ ...record, photos: photos.map(({ data, ...photo }) => photo) });

// Separate from TripState: personal photos are never included in agent snapshots.
// File mode is local development only; DATABASE_URL selects persistent PostgreSQL.
export class TravelJournalRepository {
  constructor({ databaseUrl, rootDir = resolve("runtime-data", "photo-journal") } = {}) {
    this.pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3, idleTimeoutMillis: 10_000 }) : null;
    this.rootDir = rootDir;
    this.queues = new Map();
  }
  async migrate() {
    if (!this.pool) return;
    this.ready ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(715803125)");
        await client.query(migration);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    })().catch(error => { this.ready = null; throw error; });
    await this.ready;
  }
  filename(tripId) { return resolve(this.rootDir, `${createHash("sha256").update(tripId).digest("hex")}.json`); }
  async readFile(tripId) {
    try { return JSON.parse(await readFile(this.filename(tripId), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async records(tripId) {
    if (!this.pool) return this.readFile(tripId);
    await this.migrate();
    return (await this.pool.query(`SELECT ${metadataProjection} AS record_json FROM travel_photo_journal WHERE trip_id=$1 ORDER BY created_at DESC`, [tripId])).rows.map((row) => row.record_json);
  }
  async list(tripId, nodeId) { return (await this.records(tripId)).filter((entry) => !nodeId || entry.nodeId === nodeId).map(journalSummary); }
  async get(tripId, id) {
    if (!this.pool) return (await this.readFile(tripId)).find((entry) => entry.id === id) ?? null;
    await this.migrate();
    return (await this.pool.query("SELECT record_json FROM travel_photo_journal WHERE trip_id=$1 AND entry_id=$2", [tripId, id])).rows[0]?.record_json ?? null;
  }
  async mutate(tripId, operation) {
    if (this.pool) {
      await this.migrate();
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 7194)", [tripId]);
        const records = (await client.query(`SELECT ${metadataProjection} AS record_json FROM travel_photo_journal WHERE trip_id=$1`, [tripId])).rows.map((row) => row.record_json);
        const { result, add, remove } = operation(records);
        if (add) await client.query("INSERT INTO travel_photo_journal(trip_id,entry_id,record_json) VALUES($1,$2,$3::jsonb)", [tripId, add.id, JSON.stringify(add)]);
        if (remove) await client.query("DELETE FROM travel_photo_journal WHERE trip_id=$1 AND entry_id=$2", [tripId, remove]);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
    const previous = this.queues.get(tripId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const records = await this.readFile(tripId);
      const { result, add, remove } = operation(records);
      if (!add && !remove) return result;
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const filename = this.filename(tripId);
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(add ? [add, ...records] : records.filter((entry) => entry.id !== remove)), { flag: "wx", mode: 0o600 });
        await rename(temp, filename);
      } finally { await rm(temp, { force: true }); }
      return result;
    });
    this.queues.set(tripId, pending);
    try { return await pending; }
    finally { if (this.queues.get(tripId) === pending) this.queues.delete(tripId); }
  }
  async create(tripId, record) {
    return this.mutate(tripId, (records) => {
      const existing = records.find((entry) => entry.id === record.id);
      if (existing) {
        if (existing.contentHash !== record.contentHash) throw fail("journal_id_conflict", 409);
        return { result: journalSummary(existing) };
      }
      if (records.length >= 40) throw fail("journal_trip_limit", 413);
      return { add: record, result: journalSummary(record) };
    });
  }
  async delete(tripId, id) { return this.mutate(tripId, () => ({ remove: id, result: null })); }
  async close() { await Promise.allSettled([...this.queues.values()]); await this.pool?.end(); }
}
