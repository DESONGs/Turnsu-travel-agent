import { Pool } from 'pg';
import { withTravelExecution } from '../../travel-agent-pi-package/src/host/execution-context.ts';
import { fencedExecutionWrite } from '../../travel-agent-pi-package/src/dsh/fenced-write.ts';
import { createDshTravelSession } from '../../src/agent/dsh-session.mjs';
const pool=new Pool({connectionString:process.env.TRAVEL_TEST_DATABASE_URL});
const input=JSON.parse(process.env.TRAVEL_DSH_FIXTURE_INPUT);
let calls=0;const model={provider:'fixture',id:'model',contextWindow:32000};
const models={streamSimple:(_m,context)=>({result:async()=>{
 const write=input.role==='A'||(input.role==='B'&&++calls===1);
 return {role:'assistant',content:write?[{type:'toolCall',id:input.role==='A'?'operation-a':'attempted-repeat-b',name:'save_fixture',arguments:{value:1}}]:[{type:'text',text:'Recovered using current facts and committed receipts.'}],stopReason:write?'toolUse':'stop',usage:{input:20,output:10,cacheRead:0,cacheWrite:0}};
}})};
const authority={runId:input.runId,userId:input.userId,workerId:input.workerId,fence:input.fence,signal:new AbortController().signal,assertCurrent:async()=>{},emit:async()=>{}};
await withTravelExecution(authority,async()=>{
 const native=await createDshTravelSession({conversationId:input.conversationId,pool,checkpoint:input.checkpoint,model,models,systemPrompt:'Read current facts and receipts. Never repeat committed work.',facts:async()=>({counter:(await pool.query('SELECT value FROM travel_dsh_test_effects WHERE id=$1',[input.runId])).rows[0]?.value??0}),tools:[{name:'save_fixture',description:'Increment the controlled test counter',parameters:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},execute:async()=>{
  await fencedExecutionWrite(pool,db=>db.query('UPDATE travel_dsh_test_effects SET value=value+1 WHERE id=$1 RETURNING value',[input.runId]),{productWrite:true,tripId:'fixture'});
  process.send?.({type:'committed'});if(input.role==='A')await new Promise(()=>{});
  return {content:[{type:'text',text:'saved'}],details:{status:'saved'}};
 }}]});
 process.send?.({type:'checkpoint',checkpoint:native.checkpoint()});
 await native.session.prompt(input.role==='A'?'Save the fixture once.':'Continue the interrupted task. Read the receipt and current state.');
 const messages=native.session.agent.state.messages;await native.session.dispose();process.send?.({type:'done',messages});
});
await pool.end();
