import {travelOperation} from '../../src/mcp/operations.ts';
const frame=document.querySelector('iframe'),status=document.querySelector('#host-state');
const request=async(path,method='GET',body)=>{const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(result.code??'fixture_request_failed');return result};
const modeContext=mode=>({displayMode:mode,availableDisplayModes:['inline','fullscreen'],theme:'light',locale:'zh-CN'});
await request('/api/auth/session','POST',{provider:'email_otp',identity:'plugin-qa@example.test'});
window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin||event.data?.jsonrpc!=='2.0')return;const{id,method,params={}}=event.data;
 const send=value=>frame.contentWindow.postMessage(value,location.origin);
 try{let result={};
 if(method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'Explicit local protocol harness',version:'1'},hostCapabilities:{},hostContext:modeContext('inline')};
 else if(method==='ui/notifications/initialized'){const {conversations}=await request('/api/conversations');const conversation=conversations.find(c=>c.tripId);if(conversation){const plan=await request(`/api/trips/${conversation.tripId}/plan`);send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{conversation,plan}}});}status.textContent='共享 API 已连接；模型和旅行资料均为受控样例。';return;}
 else if(method==='tools/call'){if(params.name!=='travel_app_action')throw new Error('fixture_tool_not_allowed');const a=params.arguments;const op=travelOperation(a.action,a.args);const path=op.path==='/api/mcp/session'?'/api/session':op.path;const value=await request(path,op.method,a.body);result={structuredContent:{status:'completed'},content:[{type:'text',text:'completed'}],_meta:{'travel/uiData':value}};}
 else if(method==='ui/request-display-mode'){frame.dataset.mode=params.mode;result={mode:params.mode};}
 else if(method==='ui/message'){status.textContent='已接收给宿主的消息；本地合同验证不代办宿主对话。';}
 else if(method==='ui/open-link'){status.textContent='已接收打开链接请求；本地合同验证不导航到外部网站。';}
 else if(method==='ui/update-model-context'){}
 else throw new Error('fixture_method_not_supported');
 if(id!==undefined)send({jsonrpc:'2.0',id,result});
 }catch(error){if(id!==undefined)send({jsonrpc:'2.0',id,error:{code:-32000,message:error.message}})}
});
frame.src='/dist-mcp/workspace.html';
