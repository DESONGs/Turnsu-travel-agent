import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TripFeedbackRecord, TripState } from "../contracts/index.js";
import { hydrateStoredTripState } from "./trip-state-hydration.js";
import { assertTravelExecutionCurrent } from "../host/execution-context.js";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function storageKey(id: string): string {
  return encodeURIComponent(id);
}

function idFromStorageKey(key: string): string | null {
  try {
    const id = decodeURIComponent(key);
    return SAFE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

function storageError(code: string, message = code): StorageError {
  return new StorageError(code, message);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function validateStoredState(value: unknown, expectedTripId: string): TripState {
  const state = hydrateStoredTripState(value);
  if (state.tripId !== expectedTripId) throw storageError("invalid_stored_trip");
  return state;
}

export interface TripRepository {
  readonly mode?: string;
  create(state: TripState): Promise<TripState>;
  get(tripId: string): Promise<TripState | null>;
  save(state: TripState, options: { expectedStorageVersion: number }): Promise<TripState>;
  list?(): Promise<TripState[]>;
  listSharedPlaceFeedback?(sourceRefs: string[]): Promise<Array<{ tripId: string; contributorKey?: string; feedback: TripFeedbackRecord }>>;
  close?(): Promise<void>;
}

export interface TripStoreOptions {
  rootDir?: string;
}

export class TripStore implements TripRepository {
  readonly rootDir: string;
  mode = "file";
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor({ rootDir = process.env.TRAVEL_AGENT_DATA_DIR ?? resolve(process.cwd(), "runtime-data", "trips") }: TripStoreOptions = {}) {
    this.rootDir = resolve(rootDir);
  }

  pathFor(tripId: string): string {
    if (!SAFE_ID.test(tripId)) throw storageError("invalid_trip_id");
    return join(this.rootDir, `${storageKey(tripId)}.json`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  private async withWriteQueue<Result>(tripId: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.writeQueues.get(tripId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    const queued = previous.then(() => current);
    this.writeQueues.set(tripId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.writeQueues.get(tripId) === queued) this.writeQueues.delete(tripId);
    }
  }

  async create(state: TripState): Promise<TripState> {
    const path = this.pathFor(state.tripId);
    await this.initialize();
    return this.withWriteQueue(state.tripId, async () => {
      if (await this.get(state.tripId)) throw storageError("trip_already_exists");
      const persisted = structuredClone(state);
      persisted.storageVersion = 0;
      let handle;
      try {
        await assertTravelExecutionCurrent();
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      } catch (error) {
        if (errorCode(error) === "EEXIST") throw storageError("trip_already_exists");
        throw error;
      } finally {
        await handle?.close();
      }
      return persisted;
    });
  }

  async get(tripId: string): Promise<TripState | null> {
    const path = this.pathFor(tripId);
    try {
      return validateStoredState(JSON.parse(await readFile(path, "utf8")), tripId);
    } catch (error) {
      const legacyPath = join(this.rootDir, `${tripId}.json`);
      if (errorCode(error) === "ENOENT" && process.platform !== "win32" && path !== legacyPath) {
        try {
          return validateStoredState(JSON.parse(await readFile(legacyPath, "utf8")), tripId);
        } catch (legacyError) {
          if (errorCode(legacyError) !== "ENOENT") throw legacyError;
        }
      }
      if (errorCode(error) === "ENOENT") return null;
      if (error instanceof SyntaxError) throw storageError("invalid_stored_trip");
      throw error;
    }
  }

  async list(): Promise<TripState[]> {
    await this.initialize();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const tripIds = [...new Set(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => idFromStorageKey(entry.name.slice(0, -5)))
      .filter((tripId): tripId is string => tripId !== null))];
    const states = await Promise.all(tripIds.map((tripId) => this.get(tripId)));
    return states.filter((state): state is TripState => state !== null).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listSharedPlaceFeedback(sourceRefs: string[]): Promise<Array<{ tripId: string; contributorKey?: string; feedback: TripFeedbackRecord }>> {
    const requested = new Set(sourceRefs.filter(Boolean));
    if (!requested.size) return [];
    const states = await this.list();
    return states.flatMap((state) => state.feedbackLedger
      .filter((feedback) => feedback.visibility === "anonymous_travelers"
        && feedback.place?.sourceRefs.some((sourceRef) => requested.has(sourceRef)))
      .map((feedback) => ({ tripId: state.tripId, contributorKey: state.collaboration?.ownerUserId ?? state.tripId, feedback })));
  }

  async save(state: TripState, { expectedStorageVersion }: { expectedStorageVersion: number }): Promise<TripState> {
    const tripId = state.tripId;
    const path = this.pathFor(tripId);
    await this.initialize();
    return this.withWriteQueue(tripId, async () => {
      const current = await this.get(tripId);
      if (!current) throw storageError("trip_not_found");
      if (current.storageVersion !== expectedStorageVersion) throw storageError("storage_conflict");

      const persisted = structuredClone(state);
      persisted.storageVersion = current.storageVersion + 1;
      const tempPath = join(this.rootDir, `.${storageKey(tripId)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(tempPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
        await handle.close();
        handle = undefined;
        await assertTravelExecutionCurrent();
        await rename(tempPath, path);
      } catch (error) {
        await handle?.close();
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
      return persisted;
    });
  }
}
