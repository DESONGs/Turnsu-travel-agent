import { afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import { runPersistenceContract } from './contract.ts';
import { runLiveWritePathContract } from './live-write-contract.ts';
import { PostgresSessionPersistence } from '__TRAVEL_PROJECT_ROOT__/travel-agent-pi-package/src/dsh/postgres-session.ts';
import { EXECUTION_MIGRATION_SQL } from '__TRAVEL_PROJECT_ROOT__/src/persistence/execution-repository.mjs';
const url=process.env.TRAVEL_TEST_DATABASE_URL!;
const schemas:string[]=[];const pools:Pool[]=[];
async function make(){const schema='dsh_contract_'+randomUUID().replaceAll('-','');schemas.push(schema);const admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);await admin.end();const a={runId:'fixture-run',conversationId:'fixture-conversation',userId:'fixture-user',workerId:'fixture-worker',fence:1};
 const open=async()=>{const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});pools.push(pool);await pool.query(EXECUTION_MIGRATION_SQL);await pool.query("INSERT INTO travel_runs(run_id,conversation_id,user_id,request_id,request_hash,input_json,status,created_at,updated_at,worker_id,fence,lease_until) VALUES('fixture-run','fixture-conversation','fixture-user','fixture','fixture','{}','running',0,0,'fixture-worker',1,9999999999999) ON CONFLICT DO NOTHING");const ctx=new Context();await ctx.plugin(Sessions);await ctx.plugin(class extends PostgresSessionPersistence{constructor(c:Context){super(c,pool,a)}});return {ctx,persistence:ctx.sessionPersistence,dispose:async()=>{await ctx.fiber.dispose();await pool.end();}}};
 const instance=await open();return {...instance,reopen:open,remount:async()=>{const x=await open();return x.ctx}};
}
runPersistenceContract('travel PostgreSQL',make);
runLiveWritePathContract('travel PostgreSQL',25,make);
afterAll(async()=>{await Promise.all(pools.map(p=>p.end().catch(()=>{})));const pool=new Pool({connectionString:url});for(const schema of schemas)await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
