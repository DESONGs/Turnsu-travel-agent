import test from 'node:test';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresTripRepository} from '../src/persistence/postgres-trip-repository.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels,fauxProvider } from '@earendil-works/pi-ai';
import { TravelConversationAgent } from '../src/agent/travel-conversation-agent.mjs';
import { TravelService } from '../src/api/travel-service.mjs';
import { TripStore } from '../travel-agent-pi-package/src/core/index.ts';
import { FileConversationRepository } from '../src/persistence/conversation-repository.mjs';
import { createTravelAnalysisRunCoordinator } from '../src/agent/travel-analysis-run-coordinator.mjs';
import { planningProvider,planningResponse } from './fixtures/jev-planning.mjs';
for(const storage of ['file',...(process.env.TRAVEL_TEST_DATABASE_URL?['postgres']:[])])for(const adopted of [false,true])test(`${storage}: replacing a hotel preserves all other stops and times in ${adopted?'an adopted plan':'a complete draft'}, then supports guarded adoption and undo`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'travel-local-choice-'));t.after(()=>rm(root,{recursive:true,force:true}));let store=new TripStore({rootDir:join(root,'trips')});let pgRepository;if(storage==='postgres'){const u=new URL(process.env.TRAVEL_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.port==='55439'&&u.pathname==='/travel_plugin');const bootstrap=new Pool({connectionString:u.href});const schema=`choice_${randomUUID().replaceAll('-','')}`;await bootstrap.query(`CREATE SCHEMA ${schema}`);u.searchParams.set('options',`-c search_path=${schema}`);pgRepository=new PostgresTripRepository({databaseUrl:u.href});t.after(async()=>{await pgRepository.close();await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);await bootstrap.end()});}
 const service=new TravelService({store,researchProvider:planningProvider(),planningRunCoordinator:createTravelAnalysisRunCoordinator()});
 const faux=fauxProvider({provider:'fixture-local-choice',models:[{id:'parent'}]});const models=createModels();models.setProvider(faux.provider);faux.setResponses(Array.from({length:20},()=>c=>planningResponse(c)));
 const agent=new TravelConversationAgent({travelService:service,conversationRepository:new FileConversationRepository({rootDir:join(root,'conversations')}),modelRuntime:{models,model:faux.getModel('parent')}});const conversation=await agent.createConversation({userId:'local-choice-owner'});const turn=await agent.reply({conversationId:conversation.conversationId,userId:'local-choice-owner',text:'上海一天预算6000，做完整行程。2026年10月15日出发'});assert.equal(turn.itineraryTrial?.status,'trial_ready');
 // Seed the controlled native-DSH plan into JSONB, then exercise the real service against that repository.
 if(pgRepository){await pgRepository.create(await store.get(turn.tripId));store=pgRepository;service.store=pgRepository;}
 if(adopted)assert.equal((await service.acceptTripChange({tripId:turn.tripId,...turn.itineraryTrial.accept})).status,'committed');
 const before=await store.get(turn.tripId);const base=before.planning.draft??before.planning.adopted;const old=base.plan.days.flatMap(d=>d.stops).find(s=>s.role==='stay_check_in');const view=await service.getTripPlanView(turn.tripId);const next=view.pendingProposals.flatMap(p=>p.byDomain.stay??[]).find(n=>n.nodeId!==old.nodeId);assert.ok(next);
 const changed=await service.previewLocalChoice({tripId:turn.tripId,baseRevision:before.revision,basePlanId:base.planId,nodeId:next.nodeId,replaceNodeId:old.nodeId});assert.equal(changed.status,'trial_ready',JSON.stringify(changed.issues));
 const staged=await store.get(turn.tripId);const saved=staged.planning.draft.plan;const unrelated=stops=>stops.filter(s=>s.nodeId!==old.nodeId&&s.nodeId!==next.nodeId);assert.deepEqual(unrelated(saved.days.flatMap(d=>d.stops)),unrelated(base.plan.days.flatMap(d=>d.stops)));assert.equal(staged.nodes.filter(n=>n.selected).length,before.nodes.filter(n=>n.selected).length,'preview does not adopt');
 assert.equal((await service.acceptTripChange({tripId:turn.tripId,...changed.accept})).status,'committed');const after=await store.get(turn.tripId);assert.ok(after.nodes.some(n=>n.nodeId===next.nodeId&&n.selected));assert.equal((await service.undoTripChange({tripId:turn.tripId,changeId:after.recentChange.changeId,baseRevision:after.revision})).status,'committed');assert.deepEqual((await store.get(turn.tripId)).nodes.filter(n=>n.selected).map(n=>n.nodeId).sort(),before.nodes.filter(n=>n.selected).map(n=>n.nodeId).sort());
 await assert.rejects(service.previewLocalChoice({tripId:turn.tripId,baseRevision:before.revision,basePlanId:base.planId,nodeId:next.nodeId,replaceNodeId:old.nodeId}),{code:'revision_conflict'});
 const revoked=await store.get(turn.tripId);revoked.collaboration={...(revoked.collaboration??{}),ownerUserId:'other-owner',memberUserIds:['other-owner']};await store.save(revoked,{expectedStorageVersion:revoked.storageVersion});await assert.rejects(agent.reply({conversationId:conversation.conversationId,userId:'local-choice-owner',text:'继续查看我的行程'}),{code:'trip_access_denied'});

});
