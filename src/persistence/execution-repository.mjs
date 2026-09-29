import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { executionError, publicExecutionEvent, RUN_TERMINAL } from "../../travel-agent-pi-package/src/host/execution-contract.ts";
import { decisionHash } from "../../travel-agent-pi-package/src/host/travel-decision-policy.ts";
import { JEV_LIMITS } from "../../travel-agent-pi-package/src/host/jev-client.ts";
import { selectReadyRuns } from "../../travel-agent-pi-package/src/host/execution-scheduling.ts";

export const EXECUTION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS travel_runs (
  run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, input_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  worker_id TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0, result_json TEXT, checkpoint_json TEXT,
  product_write_count INTEGER NOT NULL DEFAULT 0, trip_id TEXT,
  requires_image INTEGER NOT NULL DEFAULT 0, image_worker TEXT,
  not_before BIGINT NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL DEFAULT 0,
  wait_reason TEXT, continuation_json TEXT, queue_class TEXT NOT NULL DEFAULT 'continuation',
  UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS travel_runs_queue ON travel_runs(status, created_at);
CREATE INDEX IF NOT EXISTS travel_runs_conversation ON travel_runs(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS travel_runs_worker ON travel_runs(worker_id,status,lease_until);
CREATE INDEX IF NOT EXISTS travel_runs_user ON travel_runs(user_id,status);
CREATE TABLE IF NOT EXISTS travel_run_events (
  run_id TEXT NOT NULL REFERENCES travel_runs(run_id), seq INTEGER NOT NULL,
  event_json TEXT NOT NULL, PRIMARY KEY(run_id, seq)
);
CREATE TABLE IF NOT EXISTS travel_run_calls (
  run_id TEXT NOT NULL REFERENCES travel_runs(run_id), call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY(run_id, call_id)
);
CREATE TABLE IF NOT EXISTS travel_model_calls (
  call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES travel_runs(run_id),
  scope TEXT NOT NULL, created_at BIGINT NOT NULL, lease_until BIGINT NOT NULL,
  reserved_tokens INTEGER NOT NULL, status TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, call_kind TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS travel_model_calls_scope ON travel_model_calls(scope,created_at);
CREATE INDEX IF NOT EXISTS travel_model_calls_run ON travel_model_calls(run_id);
CREATE TABLE IF NOT EXISTS travel_model_limits (
  scope TEXT PRIMARY KEY, cooldown_until BIGINT NOT NULL DEFAULT 0,
  next_normal BIGINT NOT NULL DEFAULT 0, next_retry BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS travel_scheduler_state (id INTEGER PRIMARY KEY, position BIGINT NOT NULL DEFAULT 0);
INSERT INTO travel_scheduler_state(id,position) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
`;

const queues = new Map();
function record(row) {
  if (!row) return null;
  return { runId: row.run_id, conversationId: row.conversation_id, userId: row.user_id,
    requestId: row.request_id, requestHash: row.request_hash, input: JSON.parse(row.input_json),
    status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    workerId: row.worker_id, fence: Number(row.fence), leaseUntil: Number(row.lease_until), tripId: row.trip_id ?? null,
    sequence: Number(row.event_seq), requiresImage: Boolean(row.requires_image),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null,
    notBefore: Number(row.not_before ?? 0), expiresAt: Number(row.expires_at || Number(row.created_at) + 240_000), waitReason: row.wait_reason ?? null,
    queueClass: row.queue_class ?? "continuation",
    continuation: row.continuation_json ? JSON.parse(row.continuation_json) : null };
}

/** One durable queue, event log and checkpoint store. SQLite is development only. */
export class ExecutionRepository {
  constructor({ databaseUrl, pool, filename = "runtime-data/execution.sqlite", clock = Date.now } = {}) {
    this.clock = () => Number(new Date(clock()));
    this.ownsPool = !pool;
    if (databaseUrl || pool) {
      this.mode = "postgres";
      this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 10_000 });
    } else {
      this.mode = "sqlite";
      this.filename = filename === ":memory:" ? filename : resolve(filename);
      if (this.filename !== ":memory:") mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(this.filename);
      if (this.filename !== ":memory:") chmodSync(this.filename, 0o600);
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.db.exec(EXECUTION_MIGRATION_SQL);
      if (!this.db.prepare("PRAGMA table_info(travel_runs)").all().some((column) => column.name === "product_write_count")) this.db.exec("ALTER TABLE travel_runs ADD COLUMN product_write_count INTEGER NOT NULL DEFAULT 0");
      if (!this.db.prepare("PRAGMA table_info(travel_runs)").all().some((column) => column.name === "trip_id")) this.db.exec("ALTER TABLE travel_runs ADD COLUMN trip_id TEXT");
      for (const [name, type] of Object.entries({ not_before: "BIGINT NOT NULL DEFAULT 0", expires_at: "BIGINT NOT NULL DEFAULT 0", wait_reason: "TEXT", continuation_json: "TEXT", queue_class: "TEXT NOT NULL DEFAULT 'continuation'" })) {
        if (!this.db.prepare("PRAGMA table_info(travel_runs)").all().some(column => column.name === name)) this.db.exec(`ALTER TABLE travel_runs ADD COLUMN ${name} ${type}`);
      }
      if (!this.db.prepare("PRAGMA table_info(travel_model_calls)").all().some(column => column.name === "call_kind")) this.db.exec("ALTER TABLE travel_model_calls ADD COLUMN call_kind TEXT NOT NULL DEFAULT 'normal'");
      this.db.exec("UPDATE travel_runs SET expires_at=created_at+240000 WHERE expires_at=0");
      this.queueKey = this.filename === ":memory:" ? this : this.filename;
    }
  }
  async migrate() {
    if (!this.pool) return;
    this.ready ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(715803125)");
        await client.query(EXECUTION_MIGRATION_SQL);
        await client.query("ALTER TABLE travel_runs ADD COLUMN IF NOT EXISTS product_write_count INTEGER NOT NULL DEFAULT 0");
        await client.query("ALTER TABLE travel_runs ADD COLUMN IF NOT EXISTS trip_id TEXT");
        for (const [name, type] of Object.entries({ not_before: "BIGINT NOT NULL DEFAULT 0", expires_at: "BIGINT NOT NULL DEFAULT 0", wait_reason: "TEXT", continuation_json: "TEXT", queue_class: "TEXT NOT NULL DEFAULT 'continuation'" })) await client.query(`ALTER TABLE travel_runs ADD COLUMN IF NOT EXISTS ${name} ${type}`);
        await client.query("ALTER TABLE travel_model_calls ADD COLUMN IF NOT EXISTS call_kind TEXT NOT NULL DEFAULT 'normal'");
        await client.query("UPDATE travel_runs SET expires_at=created_at+240000 WHERE expires_at=0");
        await client.query("CREATE INDEX IF NOT EXISTS travel_runs_trip ON travel_runs(trip_id,status)");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    })().catch((error) => { this.ready = null; throw error; });
    await this.ready;
  }
  sqliteQuery(sql, parameters = []) {
    const values = [];
    const query = sql.replace(/ FOR UPDATE\b/g, "").replace(/\$(\d+)/g, (_, index) => { values.push(parameters[Number(index) - 1] ?? null); return "?"; });
    const statement = this.db.prepare(query);
    if (statement.columns().length) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: Number(statement.run(...values).changes) };
  }
  async transaction(task, { scheduling = false, admission = false } = {}) {
    if (this.pool) {
      await this.migrate();
      const client = await this.pool.connect();
      try {
        await client.query(scheduling ? "BEGIN; SELECT pg_advisory_xact_lock(715803126)" : admission ? "BEGIN; SELECT pg_advisory_xact_lock(715803128)" : "BEGIN");
        const result = await task(client);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
    const previous = queues.get(this.queueKey) ?? Promise.resolve();
    let release;
    const done = new Promise((resolveDone) => { release = resolveDone; });
    const queued = previous.then(() => done);
    queues.set(this.queueKey, queued);
    await previous;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try { const value = await task({ query: (sql, values) => this.sqliteQuery(sql, values) }); this.db.exec("COMMIT"); return value; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } finally { release(); if (queues.get(this.queueKey) === queued) queues.delete(this.queueKey); }
  }
  async query(sql, values = []) {
    if (this.pool) { await this.migrate(); return this.pool.query(sql, values); }
    return this.transaction((db) => db.query(sql, values));
  }
  async append(db, runId, event) {
    const updated = await db.query("UPDATE travel_runs SET event_seq=event_seq+1, updated_at=$2 WHERE run_id=$1 RETURNING event_seq", [runId, this.clock()]);
    const sequence = Number(updated.rows[0].event_seq);
    const value = { ...publicExecutionEvent(event), sequence, at: this.clock() };
    await db.query("INSERT INTO travel_run_events(run_id,seq,event_json) VALUES($1,$2,$3)", [runId, sequence, JSON.stringify(value)]);
    return value;
  }
  async submit({ conversationId, userId, requestId, requestHash, input, requiresImage, workerId, tripId = null, maxQueued = 1000, maxUserQueued = 4 }) {
    return this.transaction(async (db) => {
      // Keep admission atomic while avoiding serial network round trips for ordinary
      // submissions. Answers use the transaction below to consume their question.
      if (this.pool && !input.answerTo) {
        const rows = await db.query(`WITH existing AS MATERIALIZED (
          SELECT * FROM travel_runs WHERE conversation_id=$2 AND request_id=$4
        ), limits AS (
          SELECT (SELECT COUNT(*) FROM travel_runs WHERE status='queued') AS queued,
          (SELECT COUNT(*) FROM travel_runs WHERE user_id=$3 AND status IN ('queued','running','cancelling')) AS user_queued,
          GREATEST($7::bigint,COALESCE((SELECT MAX(created_at)+1 FROM travel_runs WHERE conversation_id=$2),0)) AS admitted_at
        ), added AS (
          INSERT INTO travel_runs(run_id,conversation_id,user_id,request_id,request_hash,input_json,status,created_at,updated_at,requires_image,image_worker,event_seq,trip_id,expires_at,queue_class)
          SELECT $1,$2,$3,$4,$5,$6,'queued',admitted_at,admitted_at,$8,$9,1,$10,admitted_at+240000,$11
          FROM limits WHERE queued<$12 AND user_queued<$13 AND NOT EXISTS (SELECT 1 FROM existing)
          RETURNING *
        ), event AS (
          INSERT INTO travel_run_events(run_id,seq,event_json)
          SELECT run_id,1,json_build_object('type','run_queued','status','queued','sequence',1,'at',created_at)::text FROM added
        ) SELECT to_jsonb(added) AS row,false AS duplicate FROM added
          UNION ALL SELECT to_jsonb(existing),true FROM existing`,
        [`run_${randomUUID()}`, conversationId, userId, requestId, requestHash, JSON.stringify(input), this.clock(), requiresImage ? 1 : 0, requiresImage ? workerId : null, tripId, tripId && !input.planningContext ? "interactive" : "continuation", maxQueued, maxUserQueued]);
        if (!rows.rowCount) throw executionError("execution_queue_full", 429);
        const run = record(rows.rows[0].row);
        if (run.requestHash !== requestHash) throw executionError("execution_request_id_conflict");
        return { run, duplicate: rows.rows[0].duplicate };
      }
      const existing = await db.query("SELECT * FROM travel_runs WHERE conversation_id=$1 AND request_id=$2", [conversationId, requestId]);
      if (existing.rowCount) {
        const run = record(existing.rows[0]);
        if (run.requestHash !== requestHash) throw executionError("execution_request_id_conflict");
        return { run, duplicate: true };
      }
      let sourceQuestionRun = null;
      let answerHash = null;
      if (input.answerTo) {
        sourceQuestionRun = record((await db.query("SELECT * FROM travel_runs WHERE run_id=$1 FOR UPDATE", [input.answerTo.runId])).rows[0]);
        const question = sourceQuestionRun?.result?.question;
        if (!question || sourceQuestionRun.conversationId !== conversationId || question.questionId !== input.answerTo.questionId) throw executionError("question_not_found", 404);
        answerHash = decisionHash({ answerTo: input.answerTo, text: input.text });
        if (question.consumedByRunId) {
          if (question.answerHash !== answerHash) throw executionError("question_already_answered");
          return { run: record((await db.query("SELECT * FROM travel_runs WHERE run_id=$1", [question.consumedByRunId])).rows[0]), duplicate: true };
        }
        if (question.status !== "open" || question.dependencyHash !== input.answerDependencyHash) throw executionError("question_stale");
      }
      const limits = (await db.query(`SELECT
        (SELECT COUNT(*) FROM travel_runs WHERE status='queued') AS queued,
        (SELECT COUNT(*) FROM travel_runs WHERE user_id=$1 AND status IN ('queued','running','cancelling')) AS user_queued,
        (SELECT MAX(created_at) FROM travel_runs WHERE conversation_id=$2) AS latest`, [userId, conversationId])).rows[0];
      if (Number(limits.queued) >= maxQueued || Number(limits.user_queued) >= maxUserQueued) throw executionError("execution_queue_full", 429);
      const runId = `run_${randomUUID()}`;
      const now = Math.max(this.clock(), Number(limits.latest ?? 0) + 1);
      const row = (await db.query("INSERT INTO travel_runs(run_id,conversation_id,user_id,request_id,request_hash,input_json,status,created_at,updated_at,requires_image,image_worker,event_seq,trip_id,expires_at,queue_class) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$7,$8,$9,1,$10,$11,$12) RETURNING *", [runId, conversationId, userId, requestId, requestHash, JSON.stringify(input), now, requiresImage ? 1 : 0, requiresImage ? workerId : null, tripId, now + 240_000, tripId && !input.planningContext ? "interactive" : "continuation"])).rows[0];
      if (sourceQuestionRun) {
        const result = sourceQuestionRun.result;
        result.question = { ...result.question, status: "answered", consumedByRunId: runId, answerHash };
        await db.query("UPDATE travel_runs SET result_json=$2 WHERE run_id=$1", [sourceQuestionRun.runId, JSON.stringify(result)]);
        await this.append(db, sourceQuestionRun.runId, { type: "question_answered", status: "awaiting_input" });
      }
      await db.query("INSERT INTO travel_run_events(run_id,seq,event_json) VALUES($1,1,$2)", [runId, JSON.stringify({ type: "run_queued", status: "queued", sequence: 1, at: now })]);
      return { run: record(row), duplicate: false };
    }, { admission: true });
  }
  async claim(options) { return (await this.claimMany({ ...options, count: 1 }))[0] ?? null; }
  async claimMany({ workerId, leaseMs, globalLimit, perUserLimit, count = 32, imagesOnly = false }) {
    return this.transaction(async (db) => {
      const now = this.clock();
      const expired = await db.query("SELECT run_id,status,fence,requires_image,product_write_count FROM travel_runs WHERE (status IN ('running','cancelling') AND lease_until<$1) OR (status='queued' AND expires_at<=$1) FOR UPDATE", [now]);
      for (const row of expired.rows) {
        const unsafe = await db.query("SELECT 1 FROM travel_run_calls WHERE run_id=$1 AND tool_name NOT IN ('get_trip_control_view','get_trip_plan_view','calculate_trip_budget','read_analysis_context','read_analysis_evidence') LIMIT 1", [row.run_id]);
        const recoverable = this.mode === "postgres" && row.status === "running" && Number(row.fence) === 1 && !row.requires_image && !Number(row.product_write_count) && !unsafe.rowCount;
        const status = recoverable ? "queued" : row.status === "cancelling" ? "cancelled" : "interrupted";
        await db.query("UPDATE travel_runs SET status=$2, fence=fence+1 WHERE run_id=$1", [row.run_id, status]);
        await this.append(db, row.run_id, { type: recoverable ? "run_recovering" : "run_interrupted", status, code: row.status === "queued" ? "execution_queue_timeout" : "worker_lease_expired" });
      }
      const active = await db.query("SELECT COUNT(*) AS total FROM travel_runs WHERE status IN ('running','cancelling')");
      const slots = Math.min(count, globalLimit - Number(active.rows[0].total));
      if (slots <= 0) return [];
      const eligible = await db.query(`WITH eligible AS (SELECT r.run_id,r.user_id,r.created_at,r.updated_at,r.queue_class,
        ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.created_at,r.run_id) AS user_rank,
        (SELECT COUNT(*) FROM travel_runs u WHERE u.user_id=r.user_id AND u.status IN ('running','cancelling')) AS active_count
        FROM travel_runs r WHERE r.status='queued'
        AND r.not_before<=$3 AND r.expires_at>$3
        AND ($4=0 OR r.requires_image=1)
        AND (r.requires_image=0 OR r.image_worker=$1)
        AND NOT EXISTS (SELECT 1 FROM travel_runs a WHERE (a.conversation_id=r.conversation_id OR (r.trip_id IS NOT NULL AND a.trip_id=r.trip_id)) AND a.status IN ('running','cancelling'))
        AND NOT EXISTS (SELECT 1 FROM travel_runs q WHERE (q.conversation_id=r.conversation_id OR (r.trip_id IS NOT NULL AND q.trip_id=r.trip_id)) AND q.status='queued' AND (q.created_at<r.created_at OR (q.created_at=r.created_at AND q.run_id<r.run_id)))

        ) SELECT * FROM eligible WHERE user_rank+active_count<=$2 ORDER BY updated_at,run_id LIMIT 5000`, [workerId, perUserLimit, now, imagesOnly ? 1 : 0]);
      const position = Number((await db.query("SELECT position FROM travel_scheduler_state WHERE id=1")).rows[0].position);
      const selected = selectReadyRuns(eligible.rows.map(row => ({ runId: row.run_id, userId: row.user_id, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), queueClass: row.queue_class })), slots, position, now);
      if (!selected.runs.length) return [];
      await db.query("UPDATE travel_scheduler_state SET position=$1 WHERE id=1", [selected.position]);
      const ids = selected.runs.map(run => run.runId);
      const next = await db.query(`UPDATE travel_runs SET status='running',worker_id=$1,fence=fence+1,lease_until=$2,event_seq=event_seq+1,updated_at=$3,wait_reason=NULL
        WHERE run_id IN (${ids.map((_, i) => `$${i + 4}`).join(",")}) RETURNING *`, [workerId, now + leaseMs, now, ...ids]);
      if (!next.rowCount) return [];
      const parameters = [];
      const rows = next.rows.map((row) => {
        const offset = parameters.length;
        parameters.push(row.run_id, Number(row.event_seq), JSON.stringify({ type: "run_started", status: "running", sequence: Number(row.event_seq), at: now }));
        return `($${offset + 1},$${offset + 2},$${offset + 3})`;
      });
      await db.query(`INSERT INTO travel_run_events(run_id,seq,event_json) VALUES ${rows.join(",")}`, parameters);
      return next.rows.map(record);
    }, { scheduling: true });
  }
  async assertOwner(db, run) {
    const found = await db.query("SELECT status,worker_id,fence,lease_until FROM travel_runs WHERE run_id=$1 FOR UPDATE", [run.runId]);
    const row = found.rows[0];
    if (!row || row.status !== "running" || row.worker_id !== run.workerId || Number(row.fence) !== run.fence || Number(row.lease_until) <= this.clock()) throw executionError("execution_ownership_lost");
  }
  async assertCurrent(run) { return this.transaction((db) => this.assertOwner(db, run)); }
  async heartbeat(run, leaseMs) {
    return this.transaction(async (db) => { await this.assertOwner(db, run); await db.query("UPDATE travel_runs SET lease_until=$2 WHERE run_id=$1", [run.runId, this.clock() + leaseMs]); });
  }
  async renewWorker(workerId, leaseMs) {
    const now = this.clock();
    const result = await this.query("UPDATE travel_runs SET lease_until=$2 WHERE worker_id=$1 AND status='running' AND lease_until>$3 RETURNING run_id,fence", [workerId, now + leaseMs, now]);
    return new Map(result.rows.map((row) => [row.run_id, Number(row.fence)]));
  }
  async event(run, event) { return this.transaction(async (db) => { await this.assertOwner(db, run); return this.append(db, run.runId, event); }); }
  async checkpoint(run, checkpoint) {
    const value = JSON.stringify(checkpoint);
    if (value.length > 1_000_000) throw executionError("execution_context_too_large");
    return this.transaction(async (db) => { await this.assertOwner(db, run); await db.query("UPDATE travel_runs SET checkpoint_json=$2 WHERE run_id=$1", [run.runId, value]); });
  }
  async continuation(run, continuation) {
    const value = JSON.stringify(continuation);
    if (Buffer.byteLength(value) > 2_000_000) throw executionError("execution_context_too_large");
    return this.transaction(async db => { await this.assertOwner(db, run); await db.query("UPDATE travel_runs SET continuation_json=$2 WHERE run_id=$1", [run.runId, value]); });
  }
  async defer(run, { notBefore, waitReason, checkpoint, continuation }) {
    if (!Number.isFinite(notBefore) || !/^[a-z_]{1,60}$/.test(waitReason)) throw executionError("invalid_execution_defer");
    const payload = JSON.stringify(continuation);
    if (Buffer.byteLength(payload) > 2_000_000) throw executionError("execution_context_too_large");
    return this.transaction(async db => {
      await this.assertOwner(db, run);
      await db.query("UPDATE travel_runs SET status='queued',not_before=$2,wait_reason=$3,checkpoint_json=$4,continuation_json=$5,queue_class=$6,worker_id=NULL,lease_until=0,fence=fence+1 WHERE run_id=$1", [run.runId, notBefore, waitReason, checkpoint ? JSON.stringify(checkpoint) : null, payload, continuation?.turn?.hasPrompt ? "continuation" : "interactive"]);
      await this.append(db, run.runId, { type: "run_deferred", status: "queued", waitReason, notBefore });
    });
  }
  async databaseTime(db) {
    return this.pool ? Number((await db.query("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now) : this.clock();
  }
  async cooldownJudgment(until) {
    return this.transaction(async db => {
      if (this.pool) await db.query("SELECT pg_advisory_xact_lock(hashtextextended('typesafe_account',715803127))");
      await db.query("INSERT INTO travel_model_limits(scope,cooldown_until) VALUES('typesafe_account',$1) ON CONFLICT(scope) DO UPDATE SET cooldown_until=CASE WHEN travel_model_limits.cooldown_until>$1 THEN travel_model_limits.cooldown_until ELSE $1 END", [until]);
    });
  }
  async reserveJudgment(run, { reservedTokens, retry = false, runCalls = 32, runTokens = 400_000 }) {
    if (!Number.isSafeInteger(reservedTokens) || reservedTokens <= 0 || reservedTokens > JEV_LIMITS.inputBudget) throw executionError("jev_batch_too_large", 400);
    return this.transaction(async db => {
      const scope = "typesafe_account";
      if (this.pool) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,715803127))", [scope]);
      await this.assertOwner(db, run);
      const now = await this.databaseTime(db);
      await db.query("INSERT INTO travel_model_limits(scope) VALUES($1) ON CONFLICT(scope) DO NOTHING", [scope]);
      const limits = (await db.query("SELECT * FROM travel_model_limits WHERE scope=$1", [scope])).rows[0];
      const next = Math.max(Number(limits.cooldown_until), Number(retry ? limits.next_retry : limits.next_normal));
      if (next > now) return { notBefore: next, waitReason: "jev_capacity" };
      const rows = (await db.query("SELECT c.*,r.trip_id,r.conversation_id FROM travel_model_calls c JOIN travel_runs r ON r.run_id=c.run_id WHERE c.scope=$1 AND (c.created_at>$2 OR (c.status='running' AND c.lease_until>$3))", [scope, now - 60_000, now])).rows;
      const recent = rows.filter(row => Number(row.created_at) > now - 60_000);
      const active = rows.filter(row => row.status === "running" && Number(row.lease_until) > now);
      const group = recent.filter(row => row.call_kind === (retry ? "retry" : "normal"));
      const second = recent.filter(row => Number(row.created_at) > now - 1000);
      const oldest = items => Math.min(...items.map(row => Number(row.created_at)));
      let availableAt = now;
      if (recent.length >= JEV_LIMITS.rpm) availableAt = Math.max(availableAt, oldest(recent) + 60_001);
      if (group.length >= (retry ? JEV_LIMITS.retryRpm : JEV_LIMITS.normalRpm)) availableAt = Math.max(availableAt, oldest(group) + 60_001);
      if (second.reduce((sum, row) => sum + Math.max(Number(row.reserved_tokens), Number(row.input_tokens ?? 0)), 0) + reservedTokens > JEV_LIMITS.tps) availableAt = Math.max(availableAt, oldest(second) + 1001);
      if (active.length >= JEV_LIMITS.concurrency || active.some(row => row.run_id === run.runId || (run.tripId ? row.trip_id === run.tripId : row.conversation_id === run.conversationId))) availableAt = Math.max(availableAt, now + 250);
      if (availableAt > now) return { notBefore: availableAt, waitReason: "jev_capacity" };
      const budget = (await db.query("SELECT COUNT(*) AS calls,COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens+output_tokens ELSE reserved_tokens END),0) AS tokens FROM travel_model_calls WHERE run_id=$1", [run.runId])).rows[0];
      if (Number(budget.calls) >= runCalls || Number(budget.tokens) + reservedTokens > runTokens) throw executionError("execution_model_budget_exhausted", 429);
      const callId = `model_${randomUUID()}`;
      await db.query("INSERT INTO travel_model_calls(call_id,run_id,scope,created_at,lease_until,reserved_tokens,status,call_kind) VALUES($1,$2,$3,$4,$5,$6,'running',$7)", [callId, run.runId, scope, now, now + 30_000, reservedTokens, retry ? "retry" : "normal"]);
      await db.query(`UPDATE travel_model_limits SET ${retry ? "next_retry" : "next_normal"}=$2 WHERE scope=$1`, [scope, now + (retry ? 1000 : 56)]);
      return { callId };
    });
  }
  async previousCheckpoint(conversationId, runId) {
    const result = await this.query("SELECT checkpoint_json FROM travel_runs WHERE conversation_id=$1 AND run_id<>$2 AND checkpoint_json IS NOT NULL ORDER BY created_at DESC,run_id DESC LIMIT 1", [conversationId, runId]);
    return result.rowCount ? JSON.parse(result.rows[0].checkpoint_json) : null;
  }
  async previousTrip(conversationId) {
    const result = await this.query("SELECT trip_id FROM travel_runs WHERE conversation_id=$1 AND trip_id IS NOT NULL ORDER BY created_at DESC,run_id DESC LIMIT 1", [conversationId]);
    return result.rows[0]?.trip_id ?? null;
  }
  async bindTrip(run, tripId) {
    return this.transaction(async (db) => {
      await this.assertOwner(db, run);
      await db.query("UPDATE travel_runs SET trip_id=$2 WHERE run_id=$1", [run.runId, tripId]);
    });
  }
  async reserveModel(run, { scope, reservedTokens, concurrency, rpm, tpm, runCalls, runTokens }) {
    return this.transaction(async (db) => {
      if (this.pool) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,715803127))", [scope]);
      await this.assertOwner(db, run);
      const now = await this.databaseTime(db);
      const counts = (await db.query(`SELECT
        (SELECT COUNT(*) FROM travel_model_calls WHERE run_id=$1) AS run_calls,
        (SELECT COALESCE(SUM(CASE WHEN status='finished' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
          THEN input_tokens+output_tokens ELSE reserved_tokens END),0) FROM travel_model_calls WHERE run_id=$1) AS run_tokens`, [run.runId])).rows[0];
      if (Number(counts.run_calls) >= runCalls || Number(counts.run_tokens) + reservedTokens > runTokens) throw executionError("execution_model_budget_exhausted", 429);
      if (reservedTokens > tpm) throw executionError("model_request_exceeds_account_budget", 429);
      const calls = (await db.query("SELECT created_at,lease_until,status,reserved_tokens,input_tokens,output_tokens FROM travel_model_calls WHERE scope=$1 AND (created_at>$2 OR (status='running' AND lease_until>$3)) ORDER BY created_at", [scope, now - 60000, now])).rows;
      const active = calls.filter(call => call.status === "running" && Number(call.lease_until) > now);
      const recent = calls.filter(call => Number(call.created_at) > now - 60000);
      const tokens = call => call.status === "finished" && call.input_tokens != null && call.output_tokens != null ? Number(call.input_tokens) + Number(call.output_tokens) : Number(call.reserved_tokens);
      let notBefore = now;
      // In-flight permits may settle early; a rolling quota has a known release
      // time and must not re-create a Pi session every second while it is full.
      if (active.length >= concurrency) notBefore = Math.min(now + 1000, ...active.map(call => Number(call.lease_until)));
      if (recent.length >= rpm) notBefore = Math.max(notBefore, Number(recent[recent.length - rpm].created_at) + 60001);
      let remaining = recent.reduce((sum, call) => sum + tokens(call), 0);
      for (const call of recent) {
        if (remaining + reservedTokens <= tpm) break;
        remaining -= tokens(call);
        notBefore = Math.max(notBefore, Number(call.created_at) + 60001);
      }
      if (notBefore > now) return { notBefore, waitReason: "model_capacity" };
      const callId = `model_${randomUUID()}`;
      await db.query("INSERT INTO travel_model_calls(call_id,run_id,scope,created_at,lease_until,reserved_tokens,status) VALUES($1,$2,$3,$4,$5,$6,'running')", [callId, run.runId, scope, now, now + 240_000, reservedTokens]);
      return { callId };
    });
  }
  async finishModel(callId, usage) {
    const known = usage && [usage.input, usage.output].every((value) => Number.isSafeInteger(value) && value >= 0);
    await this.query("UPDATE travel_model_calls SET status='finished',lease_until=0,input_tokens=$2,output_tokens=$3 WHERE call_id=$1 AND status='running'", [callId, known ? usage.input : null, known ? usage.output : null]);
  }
  async call(run, { callId, toolName, argsHash, status }) {
    return this.transaction(async (db) => {
      await this.assertOwner(db, run);
      if (status === "running") {
        await db.query("INSERT INTO travel_run_calls(run_id,call_id,tool_name,args_hash,status) VALUES($1,$2,$3,$4,$5)", [run.runId, callId, toolName, argsHash, status]);
      } else await db.query("UPDATE travel_run_calls SET status=$3 WHERE run_id=$1 AND call_id=$2", [run.runId, callId, status]);
      await this.append(db, run.runId, { type: status === "running" ? "tool_started" : "tool_finished", toolName, toolCallId: callId, status });
    });
  }
  async finish(run, status, result = null) {
    if (!RUN_TERMINAL.has(status)) throw executionError("invalid_execution_completion");
    return this.transaction(async (db) => {
      const current = record((await db.query("SELECT * FROM travel_runs WHERE run_id=$1 FOR UPDATE", [run.runId])).rows[0]);
      if (!current || RUN_TERMINAL.has(current.status) || current.workerId !== run.workerId || current.fence !== run.fence) return current;
      const next = current.status === "cancelling" ? "cancelled" : current.leaseUntil <= this.clock() ? "interrupted" : status;
      const safeResult = next === "cancelled" || next === "interrupted" ? null : result;
      await db.query("UPDATE travel_runs SET status=$2,result_json=$3,lease_until=0 WHERE run_id=$1", [run.runId, next, safeResult ? JSON.stringify(safeResult) : null]);
      await this.append(db, run.runId, { type: "run_finished", status: next });
      return record((await db.query("SELECT * FROM travel_runs WHERE run_id=$1", [run.runId])).rows[0]);
    });
  }
  async cancel(runId) {
    return this.transaction(async (db) => {
      const current = record((await db.query("SELECT * FROM travel_runs WHERE run_id=$1 FOR UPDATE", [runId])).rows[0]);
      if (!current || RUN_TERMINAL.has(current.status)) return current;
      const status = current.status === "queued" ? "cancelled" : "cancelling";
      await db.query("UPDATE travel_runs SET status=$2 WHERE run_id=$1", [runId, status]);
      await this.append(db, runId, { type: "run_cancel_requested", status });
      return { ...current, status };
    });
  }
  async get(runId) { return record((await this.query("SELECT * FROM travel_runs WHERE run_id=$1", [runId])).rows[0]); }
  async byRequest(conversationId, requestId) { return record((await this.query("SELECT * FROM travel_runs WHERE conversation_id=$1 AND request_id=$2", [conversationId, requestId])).rows[0]); }
  async publicSnapshot(runId, userId, after) {
    const result = await this.query(`SELECT r.run_id,r.conversation_id,r.user_id,r.request_id,r.request_hash,r.input_json,r.status,r.created_at,r.updated_at,r.worker_id,r.fence,r.lease_until,r.event_seq,r.requires_image,r.result_json,r.trip_id,r.not_before,r.expires_at,r.wait_reason,
      c.user_id AS current_user,c.record_json->>'deletedAt' AS deleted_at,
      COALESCE((SELECT json_agg(e.event_json::json ORDER BY e.seq) FROM
        (SELECT seq,event_json FROM travel_run_events WHERE run_id=r.run_id AND seq>$2 ORDER BY seq LIMIT 128) e),'[]'::json) AS events
      FROM travel_runs r LEFT JOIN travel_conversations c ON c.conversation_id=r.conversation_id WHERE r.run_id=$1`, [runId, after]);
    const row = result.rows[0];
    if (!row || !row.current_user || row.deleted_at) throw executionError("execution_not_found", 404);
    if (row.current_user !== userId) throw executionError("conversation_access_denied", 403);
    return { run: record(row), events: row.events };
  }
  async list(conversationId) { return (await this.query("SELECT * FROM travel_runs WHERE conversation_id=$1 ORDER BY created_at DESC,run_id DESC LIMIT 12", [conversationId])).rows.map(record); }
  async events(runId, after = 0) { return (await this.query("SELECT event_json FROM travel_run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 128", [runId, after])).rows.map((row) => JSON.parse(row.event_json)); }
  async transferUserOwnership(fromUserId, toUserId) { await this.query("UPDATE travel_runs SET user_id=$2 WHERE user_id=$1", [fromUserId, toUserId]); }
  async close() { if (this.pool) { if (this.ownsPool) await this.pool.end(); } else this.db.close(); }
}
