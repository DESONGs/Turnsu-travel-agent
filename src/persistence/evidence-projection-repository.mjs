import { containsGoogleContent } from "../../travel-agent-pi-package/src/core/provider-content.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { assertSchema, EvidencePresentationBundleSchema } from "../../travel-agent-pi-package/src/core/index.ts";
import { POSTGRES_MIGRATION_SQL } from "./postgres-trip-repository.mjs";

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function repositoryError(code, details = {}) {
  return Object.assign(new Error(code), { code, details });
}

function requireSafeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw repositoryError(`invalid_${field}`);
  return value;
}

function normalizedCacheKey(value) {
  const key = String(value ?? "").trim();
  if (!/^[a-f0-9]{32,128}$/.test(key)) throw repositoryError("invalid_evidence_cache_key");
  return key;
}

function validateBundle(value) {
  return assertSchema(EvidencePresentationBundleSchema, value, "invalid_evidence_presentation_bundle");
}

function isExpired(bundle, clock) {
  return new Date(bundle.expiresAt).getTime() <= new Date(clock()).getTime();
}

export function evidenceCacheKey(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export class FileEvidenceProjectionRepository {
  constructor({ rootDir = resolve(process.cwd(), "runtime-data", "evidence-presentations"), clock = () => new Date() } = {}) {
    this.rootDir = resolve(rootDir);
    this.clock = clock;
    this.mode = "file";
    this.writeQueues = new Map();
  }

  pathFor(bundleId) {
    return join(this.rootDir, `${encodeURIComponent(requireSafeId(bundleId, "evidence_bundle_id"))}.json`);
  }

  async initialize() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  async withWriteQueue(key, task) {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolveQueue) => { release = resolveQueue; });
    const queued = previous.then(() => current);
    this.writeQueues.set(key, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.writeQueues.get(key) === queued) this.writeQueues.delete(key);
    }
  }

  async put(bundle, { cacheKey } = {}) {
    if (containsGoogleContent(bundle)) return validateBundle(structuredClone(bundle));
    const validated = validateBundle(structuredClone(bundle));
    const key = normalizedCacheKey(cacheKey);
    const path = this.pathFor(validated.bundleId);
    await this.initialize();
    return this.withWriteQueue(key, async () => {
      const record = { schemaVersion: "evidence-projection-record-v1", cacheKey: key, bundle: validated };
      const tempPath = join(this.rootDir, `.${encodeURIComponent(validated.bundleId)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(tempPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.close();
        handle = null;
        await rename(tempPath, path);
      } catch (error) {
        await handle?.close();
        await unlink(tempPath).catch(() => {});
        throw error;
      }
      return validated;
    });
  }

  async get(bundleId) {
    const path = this.pathFor(bundleId);
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      const bundle = validateBundle(record?.bundle);
      if (bundle.bundleId !== bundleId) throw repositoryError("invalid_evidence_projection_record");
      if (isExpired(bundle, this.clock)) {
        await unlink(path).catch(() => {});
        return null;
      }
      return bundle;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw repositoryError("invalid_evidence_projection_record");
      throw error;
    }
  }

  async findByCacheKey(cacheKey) {
    const key = normalizedCacheKey(cacheKey);
    await this.initialize();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(this.rootDir, entry.name), "utf8"));
        if (record?.cacheKey !== key) continue;
        return await this.get(record.bundle?.bundleId);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return null;
  }

  async deleteExpired() {
    await this.initialize();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.rootDir, entry.name);
      try {
        const record = JSON.parse(await readFile(path, "utf8"));
        if (!record?.bundle || !isExpired(validateBundle(record.bundle), this.clock)) continue;
        await unlink(path);
        deleted += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return deleted;
  }
}

export class PostgresEvidenceProjectionRepository {
  constructor({ databaseUrl, pool, clock = () => new Date() } = {}) {
    if (!pool && !databaseUrl) throw repositoryError("database_url_required");
    this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 10_000 });
    this.ownsPool = !pool;
    this.clock = clock;
    this.mode = "postgres";
  }

  async migrate() {
    await this.pool.query(POSTGRES_MIGRATION_SQL);
  }

  async put(bundle, { cacheKey } = {}) {
    if (containsGoogleContent(bundle)) return validateBundle(structuredClone(bundle));
    const validated = validateBundle(structuredClone(bundle));
    const key = normalizedCacheKey(cacheKey);
    await this.migrate();
    await this.pool.query(
      `INSERT INTO evidence_presentations (bundle_id, cache_key, trip_id, expires_at, bundle_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET
         bundle_id = EXCLUDED.bundle_id,
         trip_id = EXCLUDED.trip_id,
         expires_at = EXCLUDED.expires_at,
         bundle_json = EXCLUDED.bundle_json,
         updated_at = now()`,
      [validated.bundleId, key, validated.tripId, validated.expiresAt, JSON.stringify(validated)],
    );
    return validated;
  }

  async get(bundleId) {
    requireSafeId(bundleId, "evidence_bundle_id");
    await this.migrate();
    const result = await this.pool.query("SELECT bundle_json FROM evidence_presentations WHERE bundle_id = $1 AND expires_at > $2", [bundleId, new Date(this.clock()).toISOString()]);
    return result.rowCount ? validateBundle(result.rows[0].bundle_json) : null;
  }

  async findByCacheKey(cacheKey) {
    const key = normalizedCacheKey(cacheKey);
    await this.migrate();
    const result = await this.pool.query("SELECT bundle_json FROM evidence_presentations WHERE cache_key = $1 AND expires_at > $2", [key, new Date(this.clock()).toISOString()]);
    return result.rowCount ? validateBundle(result.rows[0].bundle_json) : null;
  }

  async deleteExpired() {
    await this.migrate();
    const result = await this.pool.query("DELETE FROM evidence_presentations WHERE expires_at <= $1", [new Date(this.clock()).toISOString()]);
    return result.rowCount ?? 0;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export function createEvidenceProjectionRepository({ databaseUrl = process.env.DATABASE_URL, rootDir, pool, clock } = {}) {
  if (databaseUrl || pool) return new PostgresEvidenceProjectionRepository({ databaseUrl, pool, clock });
  return new FileEvidenceProjectionRepository({ rootDir, clock });
}
