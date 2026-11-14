import { randomUUID } from 'node:crypto';
import type { ItineraryPlan, DecisionNodeInput } from '../contracts/index.js';
export function localChoicePlan(base:ItineraryPlan,nodes:DecisionNodeInput[],{nodeId,replaceNodeId,baseRevision}:{nodeId:string;replaceNodeId:string;baseRevision:number}):ItineraryPlan{
 const fail=(code:string):never=>{throw Object.assign(new Error(code),{code,status:409})};
 const nextNode=nodes.find(n=>n.nodeId===nodeId),previous=nodes.find(n=>n.nodeId===replaceNodeId);
 if(!nextNode||!previous||nextNode.domain!==previous.domain)return fail('local_choice_not_found');
 if(nodeId===replaceNodeId)return fail('local_choice_unchanged');
 if(previous.lock?.kind==='booked'||previous.lock?.kind==='hard'||base.fixedAnchors.some(a=>a.nodeId===replaceNodeId))return fail('local_choice_locked');
 if(!base.days.some(day=>day.stops.some(s=>s.nodeId===replaceNodeId)))return fail('local_choice_not_in_plan');
 const plan=structuredClone(base);plan.runId=`local_${randomUUID()}`;plan.attempt=1;plan.baseRevision=baseRevision;
 plan.objective=`只替换${previous.title}为${nextNode.title}，保留其余安排与时间`;
 for(const day of plan.days)for(const stop of day.stops){if(stop.nodeId!==replaceNodeId)continue;stop.nodeId=nodeId;stop.stopId=`change_${randomUUID()}`;}
 const included=new Set(plan.days.flatMap(day=>day.stops.map(stop=>stop.nodeId)));
 plan.evidenceRefs=[...new Set(nodes.filter(node=>node.nodeId!==undefined&&included.has(node.nodeId)).flatMap(node=>{
  const refs=(node.operability as Record<string,unknown>|undefined)?.evidenceRefs;
  return [...(node.sourceRefs??[]),...(Array.isArray(refs)?refs.filter((ref):ref is string=>typeof ref==='string'):[])];
 }))].slice(0,64);
 return plan;
}
