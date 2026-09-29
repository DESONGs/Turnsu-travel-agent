import assert from 'node:assert/strict';
import { Agent } from '../../../../node_modules/@earendil-works/pi-agent-core/dist/index.js';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '../../../../node_modules/@earendil-works/pi-ai/dist/index.js';
import { Type } from '../../../../node_modules/typebox/build/index.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));
let sequence = 0;
function makeAgent(responses, tools = [], toolExecution) {
  const faux = fauxProvider({provider: `probe-${++sequence}`, models: [{id:'probe'}]});
  const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  return new Agent({initialState:{model:faux.getModel('probe'),tools},streamFn:models.streamSimple.bind(models),...(toolExecution ? {toolExecution} : {})});
}
const output = {evidence:'local installed Pi 0.84.1 with faux model; no external API'};
for (const mode of ['default','sequential']) {
  let active = 0, peak = 0;
  const tool = {name:'read_probe',label:'Read probe',description:'Read-only concurrency probe',parameters:Type.Object({}),execute:async()=>{active++;peak=Math.max(peak,active);await pause(40);active--;return {content:[{type:'text',text:'ok'}],details:{}};}};
  const agent=makeAgent([fauxAssistantMessage([fauxToolCall('read_probe',{}),fauxToolCall('read_probe',{})],{stopReason:'toolUse'}),fauxAssistantMessage('done')],[tool],mode==='default'?undefined:mode);
  await agent.prompt('probe'); assert.equal(peak,mode==='default'?2:1); output[mode+'_tool_peak']=peak;
}
let active=0,peak=0;
const response=async()=>{active++;peak=Math.max(peak,active);await pause(40);active--;return fauxAssistantMessage('done');};
await Promise.all([makeAgent([response]).prompt('A'),makeAgent([response]).prompt('B')]);
assert.equal(peak,2);output.independent_agent_peak=peak;
const single=makeAgent([async()=>{await pause(40);return fauxAssistantMessage('done');}]);
const first=single.prompt('first');
await assert.rejects(single.prompt('second'),/already processing/);await first;
output.same_agent_overlapping_prompt='rejected as expected';
console.log(JSON.stringify(output,null,2));
