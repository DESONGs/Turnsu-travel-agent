/** Local UI acceptance harness: real HTTP/DSH/PostgreSQL, explicitly fictional travel facts/model. */
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { createModels,fauxProvider } from '@earendil-works/pi-ai';
import { AccountService } from '../src/http/account-service.mjs';
import { AuthRepository } from '../src/persistence/auth-repository.mjs';
import { createHttpApp } from '../src/http/app.mjs';
import { createTravelService } from '../src/api/create-travel-service.mjs';
import { TravelConversationAgent } from '../src/agent/travel-conversation-agent.mjs';
import { createConversationRepository } from '../src/persistence/conversation-repository.mjs';
import { planningProvider,planningResponse } from '../tests/fixtures/jev-planning.mjs';
import { judgmentResponse } from '../tests/fixtures/jev-travel.mjs';
const input=process.env.TRAVEL_TEST_DATABASE_URL;if(!input)throw new Error('TRAVEL_TEST_DATABASE_URL required');const u=new URL(input);if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='55439'||u.pathname!=='/travel_plugin')throw new Error('dedicated isolated database required');
const schema = process.env.TRAVEL_UI_VALIDATION_SCHEMA ?? 'travel_plugin_ui'; if (!['travel_plugin_ui', 'travel_unified_ui'].includes(schema)) throw new Error('unknown controlled UI schema');
const bootstrap=new Pool({connectionString:input});await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);await bootstrap.end();u.searchParams.set('options',`-c search_path=${schema}`);const db=u.toString();
const env={NODE_ENV:'test',DATABASE_URL:db,TRAVEL_AGENT_DATA_DIR:resolve(`/tmp/${schema}-runtime`),TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH:'true',TRAVEL_AGENT_EXECUTION_ROLE:'all',TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE:'postgres_run',TRAVEL_AGENT_PUBLIC_ORIGIN:'http://127.0.0.1:8809',TYPESAFE_API_KEY:'fixture',TRAVEL_AGENT_JEV_MODE:'auto'};
const provider=planningProvider();const research=provider.research.bind(provider);provider.research=async input=>{const value=await research(input);for(const [domain,nodes]of Object.entries(value.byDomain))for(const[n,node]of nodes.entries()){node.title=({stay:['人民广场 · 庭院酒店','静安寺 · 城市酒店','北外滩 · 景观酒店'],food:['本帮菜午餐','江南面馆','家常菜餐厅'],play:['上海博物馆','外滩漫步','历史街区'],transport:['杭州东 → 上海虹桥','杭州东 → 上海南','杭州 → 上海']})[domain][n]+'（受控样例）';if(domain==='stay'){node.price={amount:900+n*150,currency:'CNY',quality:'firm',unit:'per_booking',basis:'entire_stay_display_price',quantity:1,taxStatus:'included',checkedAt:new Date().toISOString()};node.cost=node.price.amount;Object.assign(node.operability,{providerRef:`room_${n}`,roomName:'双床房 · 30 m²',bedType:'双床',mealPlan:'含早餐',cancellationPolicy:'入住前 2 天免费取消',party:{adults:1,childrenAges:[],rooms:1},inventoryVerified:true,serviceDates:['2026-10-15','2026-10-16']});}}return value};
const service=createTravelService(env,{researchProvider:provider,judgmentOptions:{fetchImpl:async(_url,options)=>Response.json(judgmentResponse(JSON.parse(options.body),{scope:'planning'}))}});
const conversations=createConversationRepository({databaseUrl:db,pool:service.store.pool});const faux=fauxProvider({provider:'fixture-ui',models:[{id:'parent',contextWindow:32768}]});const models=createModels();models.setProvider(faux.provider);faux.setResponses(Array.from({length:80},()=>context=>planningResponse(context)));const agent=new TravelConversationAgent({travelService:service,conversationRepository:conversations,modelRuntime:{models,model:faux.getModel('parent')},env});
const accounts = new AccountService({repository:new AuthRepository({databaseUrl:db})});
const app=createHttpApp({accountService:accounts,travelService:service,conversationRepository:conversations,conversationAgent:agent,runtimeEnv:env,developmentAuthEnabled:true});const server=app.listen(8809,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j)});
const login=await fetch('http://127.0.0.1:8809/api/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'email_otp',identity:'plugin-qa@example.test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
const logged = await login.json();
// Fictional verified identities only in the named isolated acceptance schema. No Google login is claimed.
await accounts.repository.transaction(db => accounts.rememberGoogleProfile(db, logged.userId, {provider:'google',subject:`${schema}_owner`,email:'plugin-qa@example.test',emailVerified:true}));
await accounts.resolveIdentity({provider:'google',subject:`${schema}_companion`,displayName:'测试同行人',email:'companion@example.test',emailVerified:true});
const request=async(path,body)=>{const response=await fetch('http://127.0.0.1:8809'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw new Error(value.code);return value};
const existing=await request('/api/conversations');let conversation=(Array.isArray(existing)?existing:existing.conversations??[]).find(c=>c.tripId);
if(!conversation){conversation=await request('/api/conversations',{});const run=await request(`/api/conversations/${conversation.conversationId}/runs`,{requestId:'controlled-initial',text:'上海一天预算6000，做完整行程。2026年10月15日出发，1人。'});const final=await app.locals.executionService.wait({runId:run.runId,userId:logged.userId,signal:AbortSignal.timeout(20000)});if(final.status!=='completed')throw new Error('controlled planning failed');conversation=await request(`/api/conversations/${conversation.conversationId}`);}
process.stdout.write('Controlled UI harness ready on http://127.0.0.1:8809. Travel facts and model responses are fixtures.\n');
await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r)});await new Promise(r=>server.close(r));await app.locals.close();await accounts.repository.close();await conversations.close?.();await service.store.close?.();
