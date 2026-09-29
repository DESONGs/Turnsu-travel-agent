import { Pool } from "pg";
import { executionWrite } from "./execution-write.mjs";
import { validateConversation } from "./conversation-repository.mjs";
import { migrateTravelDatabase } from "./postgres-trip-repository.mjs";

function repositoryError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

export class PostgresConversationRepository {
  constructor({ databaseUrl, pool } = {}) {
    if (!pool && !databaseUrl) throw repositoryError("database_url_required");
    this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 10_000 });
    this.ownsPool = !pool;
    this.mode = "postgres";
  }

  async migrate() {
    await migrateTravelDatabase(this.pool);
  }

  async create(record) {
    await this.migrate();
    const persisted = { ...validateConversation(structuredClone(record)), storageVersion: 0 };
    try {
      await this.pool.query(
        "INSERT INTO travel_conversations (conversation_id, user_id, trip_id, storage_version, record_json) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [persisted.conversationId, persisted.userId, persisted.tripId, persisted.storageVersion, JSON.stringify(persisted)],
      );
      return persisted;
    } catch (error) {
      if (error?.code === "23505") throw repositoryError("conversation_already_exists");
      throw error;
    }
  }

  async get(conversationId) {
    const result = await this.pool.query("SELECT record_json FROM travel_conversations WHERE conversation_id = $1", [conversationId]);
    return result.rowCount ? validateConversation(result.rows[0].record_json, conversationId) : null;
  }

  async listByUser(userId, { includeDeleted = false } = {}) {
    const result = await this.pool.query("SELECT record_json FROM travel_conversations WHERE user_id = $1 ORDER BY updated_at DESC", [userId]);
    return result.rows.map((row) => validateConversation(row.record_json)).filter((record) => includeDeleted || record.deletedAt === null);
  }

  async save(record, { expectedStorageVersion } = {}) {
    const conversation = validateConversation(structuredClone(record));
    const nextVersion = Number(expectedStorageVersion) + 1;
    const persisted = { ...conversation, storageVersion: nextVersion };
    const result = await executionWrite(this.pool, (db) => db.query(
      `UPDATE travel_conversations
       SET user_id = $3, trip_id = $4, storage_version = $5, record_json = $6::jsonb, updated_at = now()
       WHERE conversation_id = $1 AND storage_version = $2`,
      [persisted.conversationId, expectedStorageVersion, persisted.userId, persisted.tripId, nextVersion, JSON.stringify(persisted)],
    ));
    if (!result.rowCount) {
      const exists = await this.pool.query("SELECT 1 FROM travel_conversations WHERE conversation_id = $1", [persisted.conversationId]);
      throw repositoryError(exists.rowCount ? "conversation_storage_conflict" : "conversation_not_found", { conversationId: persisted.conversationId });
    }
    return persisted;
  }

  async transferUserOwnership(fromUserId, toUserId) {
    if (fromUserId === toUserId) return { transferredConversations: 0 };
    const records = await this.listByUser(fromUserId, { includeDeleted: true });
    let transferredConversations = 0;
    for (const record of records) {
      await this.save({ ...record, userId: toUserId, accessMode: "account", guestExpiresAt: null }, { expectedStorageVersion: record.storageVersion });
      transferredConversations += 1;
    }
    return { transferredConversations };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
