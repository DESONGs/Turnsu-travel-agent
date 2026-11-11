import { isDeepStrictEqual } from "node:util";
import type { Context } from '@deepseek-ai/cordis';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
interface Writer { handle:SessionHandle; buffer:SessionEvent[]; tail:Promise<void>; error:unknown; timer:ReturnType<typeof setTimeout>|undefined; drain:()=>Promise<void> }
/** Owns the native published-event -> handle -> durability barrier path. */
export class LiveSessionWrites {
 private readonly writers=new Map<SessionId,Writer>();
 private readonly disposals=new Set<Promise<void>>();
 constructor(ctx:Context){
  ctx.on('session/event',(session,event)=>{const w=this.writers.get(session.id);if(!w)return;w.buffer.push(event);if(!w.timer&&!w.error){w.timer=setTimeout(()=>{w.timer=undefined;void w.drain().catch(()=>ctx.logger.warn(`background write for session "${session.id}" failed`))},25);w.timer.unref();}});
  ctx.on('session/flush',session=>this.writers.get(session.id)?.handle.flush());
  ctx.on('session/disposed',session=>{const w=this.writers.get(session.id);if(!w)return;const task=w.handle.close();this.disposals.add(task);void task.catch(()=>ctx.logger.warn(`final drain for session "${session.id}" failed`)).finally(()=>this.disposals.delete(task));});
  ctx.effect(()=>async()=>{const settled=await Promise.allSettled([...this.writers.values()].map(w=>w.handle.close()).concat([...this.disposals]));const errors=settled.flatMap(r=>r.status==='rejected'?[r.reason as unknown]:[]);if(errors.length)ctx.logger.warn('DSH session teardown had a failed final drain');});
 }
 attach(handle:SessionHandle):SessionHandle{
  if(handle.access!=='write')return handle;
  const rawAppend=handle.append.bind(handle),rawFlush=handle.flush.bind(handle),rawClose=handle.close.bind(handle);
  const writer:Writer={handle,buffer:[],tail:Promise.resolve(),error:undefined,timer:undefined,drain:async()=>{}};
  writer.drain=()=>{
   if(writer.timer){clearTimeout(writer.timer);writer.timer=undefined;}
   const task=writer.tail.then(async()=>{
    const batch=writer.buffer.splice(0);if(!batch.length)return;
    try {
     // A prior transaction may have committed despite a lost response. Observe
     // the exact prefix before retrying, rather than repeating an unknown write.
     if(writer.error){const stored=(await handle.read()).events;let committed=0;while(committed<batch.length&&batch[committed]!.seq<stored.length){if(!isDeepStrictEqual(stored[batch[committed]!.seq],batch[committed]))throw new Error('dsh_routed_prefix_conflict');committed++;}batch.splice(0,committed);}
     if(batch.length)await rawAppend(batch);writer.error=undefined;
    }catch(error){writer.buffer.unshift(...batch);writer.error=error instanceof Error?error:new Error(String(error));throw writer.error;}
   });
   writer.tail=task.catch(error=>{writer.error=error;});return task;
  };
  let close:Promise<void>|undefined;let closed=false;
  handle.flush=async options=>{options?.signal?.throwIfAborted();if(closed)return rawFlush(options);if(close){await close;return;}await writer.drain();if(close)await close;else await rawFlush(options)};
  handle.close=()=>close??=(async()=>{let failure:unknown;try{await writer.drain();}catch(e){failure=e;}try{await rawClose();}catch(e){failure??=e;}finally{closed=true;if(writer.timer)clearTimeout(writer.timer);if(this.writers.get(handle.id)===writer)this.writers.delete(handle.id);}if(failure)throw failure;})();
  this.writers.set(handle.id,writer);return handle;
 }
}
