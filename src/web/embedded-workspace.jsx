import { useEffect, useState } from 'react';
import { ArrowsOut, ArrowRight, MapTrifold } from '@phosphor-icons/react';
import { api } from './api-client.js';
import { TravelApp } from './travel-app.jsx';
import './embedded-workspace.css';
import { TurnsuBrand } from './workspace/TurnsuFrame.jsx';

export function EmbeddedWorkspace({bridge}) {
  const [context,setContext]=useState(bridge.getContext?.()??{});
  const [workspace,setWorkspace]=useState(null);
  const [expanded,setExpanded]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>bridge.onContext?.(setContext),[bridge]);
  useEffect(()=>bridge.onResult(value=>{if(value?.conversation||value?.plan)setWorkspace(value)}),[bridge]);
  useEffect(()=>{if(workspace?.conversation||workspace?.plan)return;let active=true;
    api.listConversations().then(async value=>{const list=Array.isArray(value)?value:value.conversations??[];const conversation=list.find(c=>c.conversationId===bridge.initialConversationId);if(conversation&&active)setWorkspace({conversation,plan:conversation.tripId?await api.plan(conversation.tripId):null});}).catch(()=>{if(active)setError('暂未读到旅行，请重新打开工作台。')});
    return()=>{active=false};
  },[bridge,workspace?.conversation,workspace?.plan]);
  const mode=context.displayMode??'inline';
  if(mode!=='inline'||expanded)return <><div className="embedded-toolbar"><button onClick={()=>{setExpanded(false);if(mode!=='inline')void bridge.requestDisplayMode('inline').catch(()=>setExpanded(true))}}>收起工作台</button></div><TravelApp /></>;
  const conversation=workspace?.conversation; const plan=workspace?.plan;
  const open=async()=>{setError('');try{if(context.availableDisplayModes?.includes('fullscreen')){const result=await bridge.requestDisplayMode('fullscreen');if(result?.mode==='fullscreen')return;}setExpanded(true)}catch{setExpanded(true)}};
  return <section className="embedded-summary turnsu-app-summary" aria-label="旅行画布"><div className="embedded-brand-row"><TurnsuBrand compact /><span>旅行</span></div><header><div><h1>{plan?.destination??conversation?.title??'旅行画布'}</h1></div><button className="decision-link" onClick={open} aria-label="展开旅行工作台"><ArrowsOut/>展开</button></header><p>{conversation?.tripId?'继续查看同一趟旅行的安排、比较和待确认修改。':'在宿主对话中说说目的地、日期和同行人，旅行会保存在这里。'}</p>
    <div className="embedded-domains">{[['stay','住宿'],['transport','交通'],['food','餐饮'],['play','体验']].map(([domain,label])=>{const selected=plan?.byDomain?.[domain]?.filter(n=>n.selected)??[];const pending=plan?.pendingProposals?.flatMap(p=>p.byDomain?.[domain]??[])??[];return <div key={domain}><span>{label}</span><strong>{selected[0]?.title??(pending.length?`${pending.length} 个候选待比较`:'待完善')}</strong></div>})}</div>
    {error?<p role="alert">{error}</p>:null}<footer><small>采用前核对路线、时间与预算</small><button className="button primary" onClick={open}>打开旅行工作台<ArrowRight/></button></footer></section>;
}
