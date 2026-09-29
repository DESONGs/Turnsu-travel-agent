import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";

export const AUTH_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS travel_auth_users (
  user_id TEXT PRIMARY KEY, display_name TEXT, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS travel_auth_identities (
  identity_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES travel_auth_users(user_id),
  provider TEXT NOT NULL, subject TEXT NOT NULL, created_at BIGINT NOT NULL,
  UNIQUE(provider, subject)
);
CREATE INDEX IF NOT EXISTS travel_auth_identities_user ON travel_auth_identities(user_id);
CREATE TABLE IF NOT EXISTS travel_auth_sessions (
  session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES travel_auth_users(user_id), provider TEXT NOT NULL,
  device TEXT NOT NULL, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL, revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS travel_auth_sessions_user ON travel_auth_sessions(user_id, expires_at);
CREATE TABLE IF NOT EXISTS travel_auth_challenges (
  code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS travel_auth_challenges_expiry ON travel_auth_challenges(expires_at);
`;

const sqliteQueues = new Map();

// Both backends use database constraints and transactions. SQLite is the local
// development store; PostgreSQL is shared by every production API instance.
export class AuthRepository {
  constructor({ databaseUrl, pool, filename } = {}) {
    if (databaseUrl || pool) {
      this.mode = "postgres";
      this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 10_000 });
    } else {
      this.mode = "sqlite";
      this.filename = filename === ":memory:" ? filename : resolve(filename ?? "runtime-data/auth.sqlite");
      if (this.filename !== ":memory:") mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(this.filename);
      if (this.filename !== ":memory:") chmodSync(this.filename, 0o600);
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.db.exec(AUTH_MIGRATION_SQL);
      this.queueKey = this.filename === ":memory:" ? this : this.filename;
    }
  }

  async migrate() {
    if (!this.pool) return;
    this.ready ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(715803120)");
        await client.query(AUTH_MIGRATION_SQL);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    })().catch((error) => { this.ready = null; throw error; });
    await this.ready;
  }

  sqliteQuery(sql, parameters = []) {
    const values = [];
    const translated = sql.replace(/ FOR UPDATE\b/g, "").replace(/\$(\d+)/g, (_, number) => {
      values.push(parameters[Number(number) - 1] ?? null);
      return "?";
    });
    const statement = this.db.prepare(translated);
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(translated)) {
      const rows = statement.all(...values);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: Number(statement.run(...values).changes) };
  }

  async query(sql, values = []) {
    if (this.pool) { await this.migrate(); return this.pool.query(sql, values); }
    return this.transaction((connection) => connection.query(sql, values));
  }

  async transaction(task) {
    if (this.pool) {
      await this.migrate();
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await task(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    }
    const previous = sqliteQueues.get(this.queueKey) ?? Promise.resolve();
    let release;
    const current = new Promise((done) => { release = done; });
    const queued = previous.then(() => current);
    sqliteQueues.set(this.queueKey, queued);
    await previous;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await task({ query: (sql, values) => this.sqliteQuery(sql, values) });
        this.db.exec("COMMIT");
        return result;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } finally {
      release();
      if (sqliteQueues.get(this.queueKey) === queued) sqliteQueues.delete(this.queueKey);
    }
  }

  async close() { if (this.pool) await this.pool.end(); else this.db.close(); }
}
