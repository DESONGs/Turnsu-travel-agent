import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PostgresConversationRepository } from "./postgres-conversation-repository.mjs";
import { assertTravelExecutionCurrent } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { DEFAULT_USER_MODEL_ID, userModelOption } from "../agent/user-model-options.mjs";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MESSAGE_ROLES = new Set(["user", "assistant", "status"]);
const GUEST_DATA_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function storageKey(id) {
  return encodeURIComponent(id);
}

function idFromStorageKey(key) {
  try {
    const id = decodeURIComponent(key);
    return SAFE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function repositoryError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function requireSafeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw repositoryError(`invalid_${field}`);
  return value;
}

export function validateConversation(record, expectedConversationId = record?.conversationId) {
  if (!record || record.schemaVersion !== "travel-conversation-v1") throw repositoryError("invalid_stored_conversation");
  if (record.conversationId !== expectedConversationId) throw repositoryError("invalid_stored_conversation");
  requireSafeId(record.conversationId, "conversation_id");
  requireSafeId(record.userId, "conversation_user_id");
  if (record.tripId !== null) requireSafeId(record.tripId, "conversation_trip_id");
  record.modelId ??= DEFAULT_USER_MODEL_ID;
  if (!userModelOption(record.modelId)) throw repositoryError("invalid_conversation_model");
  if (!Number.isInteger(record.storageVersion) || record.storageVersion < 0) throw repositoryError("invalid_conversation_storage_version");
  record.deletedAt ??= null;
  if (record.deletedAt !== null && (typeof record.deletedAt !== "string" || Number.isNaN(new Date(record.deletedAt).getTime()))) throw repositoryError("invalid_conversation_deleted_at");
  if (!Array.isArray(record.messages) || record.messages.length > 80) throw repositoryError("invalid_conversation_messages");
  for (const message of record.messages) {
    requireSafeId(message?.messageId, "conversation_message_id");
    if (!MESSAGE_ROLES.has(message?.role) || typeof message.text !== "string" || message.text.length > 8_000 || typeof message.createdAt !== "string" || (message.modelId != null && !userModelOption(message.modelId))) {
      throw repositoryError("invalid_conversation_message");
    }
  }
  return record;
}

export function createConversationRecord({ conversationId = `conversation_${randomUUID().slice(0, 8)}`, userId, tripId = null, modelId = DEFAULT_USER_MODEL_ID, clock } = {}) {
  const timestamp = new Date(clock?.() ?? Date.now()).toISOString();
  const guest = String(userId ?? "").startsWith("usr_guest_");
  return validateConversation({
    schemaVersion: "travel-conversation-v1",
    conversationId,
    userId,
    tripId,
    modelId,
    storageVersion: 0,
    messages: [],
    accessMode: guest ? "guest" : "account",
    guestExpiresAt: guest ? new Date(new Date(timestamp).getTime() + GUEST_DATA_TTL_MS).toISOString() : null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export class FileConversationRepository {
  constructor({ rootDir = process.env.TRAVEL_AGENT_CONVERSATION_DATA_DIR ?? resolve(process.cwd(), "runtime-data", "conversations") } = {}) {
    this.rootDir = resolve(rootDir);
    this.mode = "file";
    this.writeQueues = new Map();
  }

  pathFor(conversationId) {
    return join(this.rootDir, `${storageKey(requireSafeId(conversationId, "conversation_id"))}.json`);
  }

  async initialize() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  async withWriteQueue(conversationId, task) {
    const previous = this.writeQueues.get(conversationId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolveQueue) => { release = resolveQueue; });
    const queued = previous.then(() => current);
    this.writeQueues.set(conversationId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.writeQueues.get(conversationId) === queued) this.writeQueues.delete(conversationId);
    }
  }

  async create(record) {
    const conversation = validateConversation(structuredClone(record));
    const path = this.pathFor(conversation.conversationId);
    await this.initialize();
    return this.withWriteQueue(conversation.conversationId, async () => {
      if (await this.get(conversation.conversationId)) throw repositoryError("conversation_already_exists");
      const persisted = { ...conversation, storageVersion: 0 };
      let handle;
      try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      } catch (error) {
        if (error?.code === "EEXIST") throw repositoryError("conversation_already_exists");
        throw error;
      } finally {
        await handle?.close();
      }
      return persisted;
    });
  }

  async get(conversationId) {
    const path = this.pathFor(conversationId);
    try {
      return validateConversation(JSON.parse(await readFile(path, "utf8")), conversationId);
    } catch (error) {
      const legacyPath = join(this.rootDir, `${conversationId}.json`);
      if (error?.code === "ENOENT" && process.platform !== "win32" && path !== legacyPath) {
        try {
          return validateConversation(JSON.parse(await readFile(legacyPath, "utf8")), conversationId);
        } catch (legacyError) {
          if (legacyError?.code !== "ENOENT") throw legacyError;
        }
      }
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw repositoryError("invalid_stored_conversation");
      throw error;
    }
  }

  async listByUser(userId, { includeDeleted = false } = {}) {
    requireSafeId(userId, "conversation_user_id");
    await this.initialize();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const conversationIds = [...new Set(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => idFromStorageKey(entry.name.slice(0, -5)))
      .filter((conversationId) => conversationId !== null))];
    const records = await Promise.all(conversationIds.map((conversationId) => this.get(conversationId)));
    return records.filter((record) => record?.userId === userId && (includeDeleted || record.deletedAt === null)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(record, { expectedStorageVersion } = {}) {
    const conversation = validateConversation(structuredClone(record));
    const path = this.pathFor(conversation.conversationId);
    await this.initialize();
    return this.withWriteQueue(conversation.conversationId, async () => {
      const current = await this.get(conversation.conversationId);
      if (!current) throw repositoryError("conversation_not_found");
      if (current.storageVersion !== expectedStorageVersion) throw repositoryError("conversation_storage_conflict");
      const persisted = { ...conversation, storageVersion: current.storageVersion + 1 };
      const tempPath = join(this.rootDir, `.${storageKey(conversation.conversationId)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(tempPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
        await handle.close();
        handle = null;
        await assertTravelExecutionCurrent();
        await rename(tempPath, path);
      } catch (error) {
        await handle?.close();
        await unlink(tempPath).catch(() => {});
        throw error;
      }
      return persisted;
    });
  }

  async transferUserOwnership(fromUserId, toUserId) {
    requireSafeId(fromUserId, "conversation_user_id");
    requireSafeId(toUserId, "conversation_user_id");
    if (fromUserId === toUserId) return { transferredConversations: 0 };
    const records = await this.listByUser(fromUserId, { includeDeleted: true });
    let transferredConversations = 0;
    for (const record of records) {
      await this.save({ ...record, userId: toUserId, accessMode: "account", guestExpiresAt: null }, { expectedStorageVersion: record.storageVersion });
      transferredConversations += 1;
    }
    return { transferredConversations };
  }
}

export function createConversationRepository({ databaseUrl = process.env.DATABASE_URL, pool, rootDir } = {}) {
  if (databaseUrl || pool) return new PostgresConversationRepository({ databaseUrl, pool });
  return new FileConversationRepository({ rootDir });
}
