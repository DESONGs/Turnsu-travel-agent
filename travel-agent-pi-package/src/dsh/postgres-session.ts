import { LiveSessionWrites } from "./live-session-writes.js";
import type { Context } from "@deepseek-ai/cordis";
import { SessionPersistence, SessionPersistenceRevision, SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionPersistenceNotFoundError, SessionHandleClosedError, SessionReadOnlyError, SessionOwnershipLostError, assertVersion, assertStoredId, assertContiguous, materializeAppendBatch, materializeCreateHeader, validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import type { SessionHandle, SessionAccess, SessionPersistenceSnapshot, SessionPersistenceCreateOptions } from "@deepseek-ai/dsh-session-persistence";
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { SessionHeader, SessionEvent } from "@deepseek-ai/dsh-session";

export interface SqlResult { rows: Record<string, unknown>[]; rowCount: number | null }
export interface SqlConnection { query(sql: string, values?: unknown[]): Promise<SqlResult>; release(): void }
export interface SqlPool { query(sql: string, values?: unknown[]): Promise<SqlResult>; connect(): Promise<SqlConnection> }
export interface SessionAuthority { runId: string; workerId: string; fence: number; userId: string }
export const DSH_SESSION_SQL = `
CREATE TABLE IF NOT EXISTS travel_dsh_sessions (
 session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, header_json JSONB NOT NULL,
 inherited_count INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0,
 writer_epoch BIGINT NOT NULL DEFAULT 0, run_id TEXT, worker_id TEXT, run_fence BIGINT,
 revision TEXT NOT NULL, materialized INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE travel_dsh_sessions ADD COLUMN IF NOT EXISTS materialized INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS travel_dsh_events (
 session_id TEXT NOT NULL REFERENCES travel_dsh_sessions(session_id), seq INTEGER NOT NULL,
 event_json JSONB NOT NULL, PRIMARY KEY(session_id,seq)
);`;

/** Native DSH log. Every write joins the current travel run lease in PostgreSQL. */
export class PostgresSessionPersistence extends SessionPersistence {
  private readonly pending=new Set<SessionId>();
  private readonly live: LiveSessionWrites;
  private readonly handles = new Set<SessionHandle>();
  private ready: Promise<unknown> | undefined;
  constructor(ctx: Context, private readonly pool: SqlPool, private readonly authority: SessionAuthority) { super(ctx); this.live=new LiveSessionWrites(ctx); }
  private async migrate(): Promise<void> { this.ready ??= (async () => { const c=await this.pool.connect();try {await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(715803125)");await c.query(DSH_SESSION_SQL);await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}})().catch(e => { this.ready = undefined; throw e; }); await this.ready; }
  private async transaction<T>(task: (client: SqlConnection) => Promise<T>): Promise<T> {
    await this.migrate(); const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout = '8000ms'"); const result = await task(client); await client.query("COMMIT"); return result; }
    catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
  }
  private async guard(client: SqlConnection, id: SessionId): Promise<void> {
    const a = this.authority;
    const result = await client.query("SELECT run_id FROM travel_runs WHERE run_id=$1 AND user_id=$2 AND worker_id=$3 AND fence=$4 AND status='running' AND lease_until > (extract(epoch from clock_timestamp())*1000)::bigint FOR UPDATE", [a.runId, a.userId, a.workerId, a.fence]);
    if (!result.rowCount) throw new SessionOwnershipLostError(id);
  }
  private snapshot(row: Record<string, unknown>): SessionPersistenceSnapshot {
    const header = materializeCreateHeader(row.header_json as SessionHeader);
    return { header, eventCount: Number(row.event_count), revision: SessionPersistenceRevision(String(row.revision)), formatStatus: header.version === SESSION_FORMAT_VERSION ? "current" : "migration-required" };
  }
  override async create(header: SessionHeader, options: SessionPersistenceCreateOptions = {}): Promise<SessionHandle> {
    options.signal?.throwIfAborted(); header = materializeCreateHeader(header); assertVersion(header);
    const inherited = Number(options.inheritedEventCount ?? 0);
    if (!Number.isSafeInteger(inherited) || inherited < 0 || (!header.isSeeded && inherited !== 0) || (header.isSeeded && options.inheritedEventCount === undefined)) throw new TypeError("invalid_inherited_event_count");
    await this.transaction(async c => {
      await this.guard(c, header.id);
      const inserted = await c.query("INSERT INTO travel_dsh_sessions(session_id,user_id,header_json,inherited_count,revision,materialized) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING", [header.id, this.authority.userId, JSON.stringify(header), inherited, `${header.id}:0`]);
      if (!inserted.rowCount) throw new SessionAlreadyExistsError(header.id);
    });
    this.pending.add(header.id);
    return this.open(header.id, "write", options);
  }
  override async open(id: SessionId, access: SessionAccess, options: {signal?: AbortSignal} = {}): Promise<SessionHandle> {
    options.signal?.throwIfAborted();
    const row = await this.transaction(async c => {
      if (access === "write") await this.guard(c, id);
      const r = await c.query("SELECT * FROM travel_dsh_sessions WHERE session_id=$1 AND user_id=$2 FOR UPDATE", [id, this.authority.userId]); const row = r.rows[0];
      if (!row || (!row.materialized && !this.pending.has(id))) throw new SessionPersistenceNotFoundError(id);
      assertStoredId(id, row.header_json as SessionHeader); assertVersion(row.header_json as SessionHeader);
      const stored=(await c.query("SELECT event_json FROM travel_dsh_events WHERE session_id=$1 ORDER BY seq",[id])).rows.map(r=>r.event_json as SessionEvent);
      validateStoredEvents(row.header_json as SessionHeader,stored);assertContiguous(id,stored,0);
      if (access === "write") {
        // A writer belongs to one run AND one session epoch. A different run with
        // the same numeric fence must never inherit the previous writer's rights.
        if (row.run_id) {
          const owner = await c.query("SELECT run_id FROM travel_runs WHERE run_id=$1 AND worker_id=$2 AND fence=$3 AND status='running' AND lease_until > (extract(epoch from clock_timestamp())*1000)::bigint", [row.run_id,row.worker_id,row.run_fence]);
          if (owner.rowCount) throw new SessionAlreadyOwnedError(id);
        }
        const next = await c.query("UPDATE travel_dsh_sessions SET writer_epoch=writer_epoch+1,run_id=$2,worker_id=$3,run_fence=$4 WHERE session_id=$1 RETURNING *", [id,this.authority.runId,this.authority.workerId,this.authority.fence]); return next.rows[0]!;
      } return row;
    });
    const header = materializeCreateHeader(row.header_json as SessionHeader); const epoch = Number(row.writer_epoch); let closed = false; let closePromise: Promise<void> | undefined;
    const check = (operation: string, write = false) => { if (closed) throw new SessionHandleClosedError(id,operation); if (write && access !== "write") throw new SessionReadOnlyError(id,operation); };
    const owned = async (c: SqlConnection) => {
      await this.guard(c,id);
      const r = await c.query("SELECT * FROM travel_dsh_sessions WHERE session_id=$1 AND writer_epoch=$2 AND run_id=$3 AND worker_id=$4 AND run_fence=$5 FOR UPDATE", [id,epoch,this.authority.runId,this.authority.workerId,this.authority.fence]);
      if (!r.rows[0]) throw new SessionOwnershipLostError(id); return r.rows[0];
    };
    const handle: SessionHandle = {
      id, header, access, inheritedEventCount: SessionLogOffset(Number(row.inherited_count)),
      read: async (offset = 0,length = Number.MAX_SAFE_INTEGER,opts = {}) => {
        check("read"); opts.signal?.throwIfAborted();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new RangeError("offset and length must be a non-negative safe integer");
        const r = await this.pool.query("SELECT event_json FROM travel_dsh_events WHERE session_id=$1 AND seq >= $2 AND seq::bigint < $3 ORDER BY seq",[id,offset,Math.min(Number.MAX_SAFE_INTEGER,offset+length)]);
        const events = validateStoredEvents(header,r.rows.map(r => r.event_json as SessionEvent));
        assertContiguous(id,events,offset); return { eventState: "detached", events };
      },
      append: async (events,opts = {}) => {
        check("append",true); opts.signal?.throwIfAborted(); const batch = materializeAppendBatch(events);
        await this.persistBatch(header,batch,owned);
      },
      flush: async (opts = {}) => { check("flush",true); opts.signal?.throwIfAborted(); await this.transaction(async c=>{await owned(c);await c.query("UPDATE travel_dsh_sessions SET materialized=1 WHERE session_id=$1",[id]);});this.pending.delete(id); },
      close: () => closePromise ??= (async () => {
        if (closed) return; let failure: unknown;
        try { if (access === "write") await this.transaction(async c=>{const r=await owned(c);if(!Number(r.materialized)&&Number(r.event_count)===0)await c.query("DELETE FROM travel_dsh_sessions WHERE session_id=$1",[id]);}); } catch (e) { failure = e; }
        finally { closed = true; this.pending.delete(id); this.handles.delete(handle); if (access === "write") await this.pool.query("UPDATE travel_dsh_sessions SET run_id=NULL,worker_id=NULL,run_fence=NULL WHERE session_id=$1 AND writer_epoch=$2 AND run_id=$3 AND worker_id=$4 AND run_fence=$5",[id,epoch,this.authority.runId,this.authority.workerId,this.authority.fence]); }
        if (failure) throw failure;
      })(),
      [Symbol.asyncDispose]: async () => handle.close(),
    };
    this.handles.add(handle); return this.live.attach(handle);
  }
  async persistBatch(header:SessionHeader,batch:readonly SessionEvent[],owned:(c:SqlConnection)=>Promise<Record<string,unknown>>):Promise<void>{
    const id=header.id;
    await this.transaction(async c => {
          const r = await owned(c); assertContiguous(id,batch,Number(r.event_count));
          for (const event of batch) await c.query("INSERT INTO travel_dsh_events(session_id,seq,event_json) VALUES($1,$2,$3)",[id,event.seq,JSON.stringify(event)]);
          if (batch.length) await c.query("UPDATE travel_dsh_sessions SET event_count=event_count+$2,revision=$3,materialized=1 WHERE session_id=$1",[id,batch.length,`${id}:${Number(r.event_count)+batch.length}`]);
        });
  }
  override async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.handles].filter(h => h.access === "write").map(h => h.flush()));
    const errors = results.flatMap(r => r.status === "rejected" ? [r.reason as unknown] : []); if (errors.length) throw new AggregateError(errors,"dsh_session_flush_failed");
  }
  override async stat(id: SessionId, options: {signal?: AbortSignal} = {}): Promise<SessionPersistenceSnapshot | undefined> {
    options.signal?.throwIfAborted(); await this.migrate(); const r = await this.pool.query("SELECT * FROM travel_dsh_sessions WHERE session_id=$1 AND user_id=$2",[id,this.authority.userId]); return r.rows[0] && (r.rows[0].materialized || this.pending.has(id)) ? this.snapshot(r.rows[0]) : undefined;
  }
  override async list(options: {signal?: AbortSignal} = {}): Promise<readonly SessionPersistenceSnapshot[]> {
    options.signal?.throwIfAborted(); await this.migrate(); const r = await this.pool.query("SELECT * FROM travel_dsh_sessions WHERE user_id=$1",[this.authority.userId]); return r.rows.filter(r=>r.materialized||this.pending.has(SessionId(String(r.session_id)))).map(r => this.snapshot(r));
  }
}
