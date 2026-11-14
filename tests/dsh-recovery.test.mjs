import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { PostgresSessionPersistence, DSH_SESSION_SQL } from '../travel-agent-pi-package/src/dsh/postgres-session.ts';
import { OPERATION_RECEIPT_SQL, fencedExecutionWrite, withTravelOperation } from '../travel-agent-pi-package/src/dsh/fenced-write.ts';
import { withTravelExecution } from '../travel-agent-pi-package/src/host/execution-context.ts';
import { EXECUTION_MIGRATION_SQL, ExecutionRepository } from '../src/persistence/execution-repository.mjs';
import { createDshTravelSession } from '../src/agent/dsh-session.mjs';
const url=process.env.TRAVEL_TEST_DATABASE_URL;
async function localDatabase(){const u=new URL(url);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&u.port==='55439'&&u.pathname==='/travel_plugin','use the dedicated isolated PostgreSQL');const schema='recovery_'+randomUUID().replaceAll('-','');const admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);await admin.end();u.searchParams.set('options',`-c search_path=${schema}`);const pool=new Pool({connectionString:u.toString(),max:8});const end=pool.end.bind(pool);let closing;pool.end=()=>closing??=(async()=>{await end();const cleanup=new Pool({connectionString:url});await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);await cleanup.end()})();return pool;}

async function seed(pool,authority){await pool.query("CREATE TABLE IF NOT EXISTS trip_states(trip_id TEXT PRIMARY KEY,storage_version INTEGER NOT NULL DEFAULT 0,state_json JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())");await pool.query(EXECUTION_MIGRATION_SQL);await pool.query(DSH_SESSION_SQL);await pool.query(OPERATION_RECEIPT_SQL);const a=authority;await pool.query("INSERT INTO travel_runs(run_id,conversation_id,user_id,request_id,request_hash,input_json,status,created_at,updated_at,worker_id,fence,lease_until,expires_at) VALUES($1,$2,$3,$1,'fixture','{}','running',0,0,$4,$5,(extract(epoch from clock_timestamp())*1000)::bigint+60000,(extract(epoch from clock_timestamp())*1000)::bigint+240000)",[a.runId,a.conversationId,a.userId,a.workerId,a.fence]);}
const authority=()=>({runId:`run_${randomUUID()}`,conversationId:`conversation_${randomUUID()}`,userId:`user_${randomUUID()}`,workerId:'A',fence:1});
const live=a=>({...a,signal:new AbortController().signal,assertCurrent:async()=>{},emit:async()=>{}});
async function store(pool,a){const c=new Context();const f=await c.plugin(class extends PostgresSessionPersistence{constructor(ctx){super(ctx,pool,a)}});return {service:c.sessionPersistence,close:()=>f.dispose()};}
const fixtureModel={provider:'fixture',id:'native-model',contextWindow:32000};
const fixtureModels={streamSimple:()=>({result:async()=>({content:[{type:'text',text:'native DSH response'}],stopReason:'stop',usage:{input:2,output:3,cacheRead:0,cacheWrite:0}})})};
test('native DSH session restores a development checkpoint without persisting request images',async()=>{
 let sawImage=false;const models={streamSimple:(_m,c)=>{sawImage=JSON.stringify(c).includes('fixture-image');return fixtureModels.streamSimple()}};
 const n=await createDshTravelSession({conversationId:'restore',models,model:fixtureModel,systemPrompt:'travel',facts:async()=>({revision:1}),tools:[]});await n.session.prompt('image',{images:[{data:'fixture-image',mimeType:'image/png'}]});const checkpoint=n.checkpoint();assert.equal(n.session.messages.find(m=>m.role==='assistant').usage.input,2);assert.equal(n.session.messages.find(m=>m.role==='assistant').usage.output,3);assert.ok(sawImage);assert.ok(!JSON.stringify(checkpoint).includes('fixture-image'));await n.session.dispose();
 const resumed=await createDshTravelSession({conversationId:'restore',checkpoint,models:fixtureModels,model:fixtureModel,systemPrompt:'travel',facts:async()=>({revision:2}),tools:[]});await resumed.session.prompt('continue');assert.equal(resumed.session.messages.filter(m=>m.role==='assistant').length,2);await resumed.session.dispose();
});
test('PostgreSQL native session fences expired owners, late close and separate runs with equal fences',{skip:!url},async()=>{
 const pool=await localDatabase();const a=authority();await seed(pool,a);const A=await store(pool,a);const id=SessionId(`session_${randomUUID()}`);const h=await A.service.create({id,version:SESSION_FORMAT_VERSION,createdAt:Date.now()});await h.flush();
 const B=await store(pool,{...a,workerId:'B',fence:3});await assert.rejects(A.service.open(id,'write'),{name:'SessionAlreadyOwnedError'});await assert.rejects(B.service.open(id,'write'),{name:'SessionOwnershipLostError'});
 await pool.query('UPDATE travel_runs SET lease_until=0 WHERE run_id=$1',[a.runId]);await assert.rejects(h.append([]),{name:'SessionOwnershipLostError'});await assert.rejects(h.flush(),{name:'SessionOwnershipLostError'});
 await pool.query("UPDATE travel_runs SET worker_id='B',fence=3,lease_until=(extract(epoch from clock_timestamp())*1000)::bigint+60000 WHERE run_id=$1",[a.runId]);const next=await B.service.open(id,'write');await assert.rejects(h.close(),{name:'SessionOwnershipLostError'});await next.flush();const r=await B.service.open(id,'read');await assert.rejects(r.append([]),{name:'SessionReadOnlyError'});await r.close();await assert.rejects(r.read(),{name:'SessionHandleClosedError'});
 const rev=(await B.service.stat(id)).revision;await next.close();const other={...a,runId:`run_${randomUUID()}`,workerId:'C',fence:3};await seed(pool,other);const C=await store(pool,other);const third=await C.service.open(id,'write');assert.equal((await C.service.stat(id)).revision,rev);await next.close();await third.flush();await third.close();await Promise.all([A.close(),B.close(),C.close()]);await pool.end();
});
test('business writes and receipts commit once, and expired owners cannot mutate',{skip:!url},async()=>{
 const pool=await localDatabase();const a=authority();await seed(pool,a);await pool.query('CREATE TABLE IF NOT EXISTS travel_dsh_test_effects(id TEXT PRIMARY KEY,value INTEGER NOT NULL)');await pool.query('INSERT INTO travel_dsh_test_effects VALUES($1,0)',[a.runId]);const operation=`op_${randomUUID()}`;
 const save=()=>withTravelExecution(live(a),()=>withTravelOperation(operation,'same-args',()=>fencedExecutionWrite(pool,c=>c.query('UPDATE travel_dsh_test_effects SET value=value+1 WHERE id=$1 RETURNING value',[a.runId]),{productWrite:true,tripId:'fixture'})));
 assert.equal((await save()).rows[0].value,1);assert.equal((await save()).rows[0].value,1);assert.equal((await pool.query('SELECT value FROM travel_dsh_test_effects WHERE id=$1',[a.runId])).rows[0].value,1);
 await pool.query('UPDATE travel_runs SET lease_until=0 WHERE run_id=$1',[a.runId]);await assert.rejects(save(),{code:'execution_ownership_lost'});await pool.end();
});
test('separate DSH worker processes recover after commit-before-tool-result without repeating the write',{skip:!url,timeout:20000},async()=>{
 const pool=await localDatabase();const a=authority();await seed(pool,a);await pool.query('CREATE TABLE IF NOT EXISTS travel_dsh_test_effects(id TEXT PRIMARY KEY,value INTEGER NOT NULL)');await pool.query('INSERT INTO travel_dsh_test_effects VALUES($1,0)',[a.runId]);
 const start=input=>fork(new URL('./fixtures/dsh-process.mjs',import.meta.url),[],{env:{PATH:process.env.PATH,TRAVEL_TEST_DATABASE_URL:pool.options.connectionString,DSH_HOME:`/tmp/travel-native-${randomUUID()}`,TRAVEL_DSH_FIXTURE_INPUT:JSON.stringify(input)},execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
 const waitMessage=(child,type)=>new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type===type)resolve(m)});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(`worker exited ${code}`))});});
 const A=start({...a,role:'A'});let stderr='';A.stderr.on('data',b=>stderr+=b);const checkpointPromise=waitMessage(A,'checkpoint');const committed=waitMessage(A,'committed');const checkpoint=(await checkpointPromise).checkpoint;await committed;const durable=(await pool.query('SELECT event_json FROM travel_dsh_events WHERE session_id=$1 ORDER BY seq',[checkpoint.sessionId])).rows.map(r=>r.event_json);assert.ok(durable.length>8);assert.ok(durable.some(e=>e.type==='tool/call'&&e.data.name==='save_fixture'));assert.deepEqual(durable.map(e=>e.seq),durable.map((_,i)=>i));A.kill('SIGKILL');await once(A,'exit');
 await pool.query('UPDATE travel_runs SET lease_until=0,checkpoint_json=$2 WHERE run_id=$1',[a.runId,JSON.stringify(checkpoint)]);
 const repository=new ExecutionRepository({pool,clock:()=>Date.now()+86400000});await repository.migrate();const recovered=await repository.claim({workerId:'B',leaseMs:60000,globalLimit:10,perUserLimit:2});assert.equal(recovered.runId,a.runId,'database time ignores a worker clock skew of one day');
 const B=start({...a,role:'B',workerId:'B',fence:recovered.fence,checkpoint});B.stderr.on('data',b=>stderr+=b);const done=await waitMessage(B,'done');await once(B,'exit');assert.ok(done.messages.some(m=>m.role==='assistant'&&JSON.stringify(m).includes('Recovered')));assert.ok(done.messages.some(m=>JSON.stringify(m).includes('operation-a')),'B must restore the original call and its repaired unknown outcome');assert.equal((await pool.query('SELECT value FROM travel_dsh_test_effects WHERE id=$1',[a.runId])).rows[0].value,1,stderr);await pool.end();
});
test('sensitive model tool arguments are blocked before entering the native session log',async()=>{
 const secret='fixture-secret-never-store';const models={streamSimple:()=>({result:async()=>({content:[{type:'toolCall',id:'sensitive-call',name:'travel',arguments:{token:secret}}],stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0}})})};const n=await createDshTravelSession({conversationId:'secret-check',models,model:fixtureModel,systemPrompt:'travel',facts:async()=>({}),tools:[],isSensitive:t=>t.includes(secret)});try{await assert.rejects(n.session.prompt('continue'));assert.ok(!JSON.stringify(n.checkpoint()).includes(secret));}finally{await n.session.dispose()}
});
