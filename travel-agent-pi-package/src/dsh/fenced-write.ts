import { AsyncLocalStorage } from 'node:async_hooks';
import { currentTravelExecution } from '../host/execution-context.js';
import { executionError } from '../host/execution-contract.js';
import type { SqlPool, SqlResult } from './postgres-session.js';
interface Operation { id:string; argsHash:string; mutation:number; toolName:string }
const operations=new AsyncLocalStorage<Operation>();
export function withTravelOperation<T>(id:string,argsHash:string,task:()=>T,toolName="unknown"):T { return operations.run({id,argsHash,mutation:0,toolName},task); }
export const OPERATION_RECEIPT_SQL=`CREATE TABLE IF NOT EXISTS travel_operation_receipts (
 user_id TEXT NOT NULL,operation_id TEXT NOT NULL,mutation_index INTEGER NOT NULL,args_hash TEXT NOT NULL,tool_name TEXT NOT NULL,
 run_id TEXT NOT NULL,trip_id TEXT,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,operation_id,mutation_index)
);
ALTER TABLE travel_operation_receipts ADD COLUMN IF NOT EXISTS tool_name TEXT NOT NULL DEFAULT 'unknown';`;
/** The authoritative run lock, mutation and receipt share one database commit. */
export async function fencedExecutionWrite(pool:SqlPool,action:(db:SqlPool|Awaited<ReturnType<SqlPool['connect']>>)=>Promise<SqlResult>,{productWrite=false,tripId=null}:{productWrite?:boolean;tripId?:string|null}={}):Promise<SqlResult>{
 const context=currentTravelExecution();const operation=operations.getStore();
 if(!context){if(operation)throw executionError('execution_context_required');return action(pool);}
 context.signal.throwIfAborted();const mutation=operation ? operation.mutation++ : undefined;const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='8000ms'");
  const result=await client.query("SELECT run_id FROM travel_runs WHERE run_id=$1 AND user_id=$2 AND status='running' AND worker_id=$3 AND fence=$4 AND lease_until>(extract(epoch from clock_timestamp())*1000)::bigint FOR UPDATE",[context.runId,context.userId,context.workerId,context.fence]);
  if(!result.rowCount)throw executionError('execution_ownership_lost');context.signal.throwIfAborted();
  if(productWrite&&tripId){
   const state=(await client.query("SELECT state_json->'collaboration'->'memberUserIds' AS members FROM trip_states WHERE trip_id=$1 FOR UPDATE",[tripId])).rows[0];
   if(state&&(!Array.isArray(state.members)||!state.members.includes(context.userId)))throw executionError('trip_access_denied');
  }
  if(productWrite&&operation){
   const receipt=await client.query('SELECT args_hash,result_json FROM travel_operation_receipts WHERE user_id=$1 AND operation_id=$2 AND mutation_index=$3',[context.userId,operation.id,mutation]);
   if(receipt.rows[0]){if(receipt.rows[0].args_hash!==operation.argsHash)throw executionError('operation_id_conflict');await client.query('COMMIT');return receipt.rows[0].result_json as SqlResult;}
  }
  if(productWrite)await client.query('UPDATE travel_runs SET product_write_count=product_write_count+1,trip_id=COALESCE(trip_id,$2) WHERE run_id=$1',[context.runId,tripId]);
  const value=await action(client);
  if(productWrite&&operation)await client.query('INSERT INTO travel_operation_receipts(user_id,operation_id,mutation_index,args_hash,run_id,trip_id,result_json,tool_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[context.userId,operation.id,mutation,operation.argsHash,context.runId,tripId,JSON.stringify({rowCount:value.rowCount,rows:value.rows}),operation.toolName]);
  await client.query('COMMIT');return value;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}finally{client.release()}
}
