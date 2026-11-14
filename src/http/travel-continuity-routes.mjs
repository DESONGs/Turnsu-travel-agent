import { ContinuityRepository } from '../persistence/continuity-repository.mjs';
import { TravelContinuityService } from '../../travel-agent-pi-package/src/product/continuity.ts';
import { watchOffer, createWatchQuoteSource } from '../providers/price-watch.mjs';
import { createNotificationMailer } from '../providers/notification-email.mjs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { httpError } from './http-errors.mjs';

export function registerTravelContinuityRoutes({app,asyncRoute,requireSession,requireTripMember,travelService,env,service}){
  const repository=service?null:new ContinuityRepository({databaseUrl:env.DATABASE_URL,filename:resolve(env.TRAVEL_AGENT_DATA_DIR??'runtime-data','continuity.sqlite')});
  const continuity=service??new TravelContinuityService(repository,createWatchQuoteSource(travelService),createNotificationMailer(env));
  travelService.continuity=continuity;
  const member=async req=>{const s=await requireSession(req);if(s.provider==='guest')throw httpError('authentication_required',401);return s.userId};
  app.get('/api/preferences',asyncRoute(async(req,res)=>res.json(await continuity.preferences(await member(req)))));
  app.post('/api/preferences',asyncRoute(async(req,res)=>{const userId=await member(req);const {revision,enabled,text,context,id,remove}=req.body??{};res.json(await continuity.changePreferences(userId,{revision,enabled,text,context,id,remove,origin:'explicit'}));}));
  app.post('/api/preferences/:id/confirm',asyncRoute(async(req,res)=>{await continuity.confirmPreference(await member(req),req.params.id,req.body?.revision);res.json({status:'saved'});}));
  app.get('/api/price-watches',asyncRoute(async(req,res)=>res.json(await continuity.watches(await member(req)))));
  app.post('/api/price-watches/:watchId/recheck',asyncRoute(async(req,res)=>res.json(await continuity.recheckWatch(await member(req),req.params.watchId,AbortSignal.timeout(45000)))));
  app.get('/api/trips/:tripId/watch-offers',asyncRoute(async(req,res)=>{await requireTripMember(req,req.params.tripId);const state=await travelService.store.get(req.params.tripId);const plan=await travelService.getTripPlanView(req.params.tripId);const rows=[...Object.entries(plan.byDomain??{}).flatMap(([domain,nodes])=>nodes.map(n=>({...n,domain}))),...(plan.pendingProposals??[]).flatMap(p=>Object.entries(p.byDomain??{}).flatMap(([domain,nodes])=>nodes.map(n=>({...n,domain}))))];res.json([...new Map(rows.filter(n=>['stay','transport'].includes(n.domain)).map(n=>[n.nodeId,{nodeId:n.nodeId,title:n.title,offer:watchOffer(n,state.brief)}])).values()]);}));
  app.post('/api/price-watches',asyncRoute(async(req,res)=>{
    const userId=await member(req);const {tripId,nodeId,targetAmount,expiresAt,email,requestId}=req.body??{};await requireTripMember(req,tripId);
    const state=await travelService.store.get(tripId);const plan=await travelService.getTripPlanView(tripId);
    const nodes=Object.entries(plan.byDomain??{}).flatMap(([domain,nodes])=>nodes.map(n=>({...n,domain}))).concat((plan.pendingProposals??[]).flatMap(p=>Object.entries(p.byDomain??{}).flatMap(([domain,nodes])=>nodes.map(n=>({...n,domain})))));
    const node=nodes.find(n=>n.nodeId===nodeId);if(!node)throw httpError('candidate_not_found',404);
    const quote=watchOffer(node,state.brief);if(!quote.eligible)throw httpError('watch_conditions_incomplete',409,{missing:quote.missing});
    res.status(201).json(await continuity.createWatch(userId,{tripId,nodeId,title:node.title,conditions:quote.conditions,targetAmount,expiresAt:Date.parse(expiresAt),email:email===true},requestId));
  }));
  app.post('/api/price-watches/:watchId',asyncRoute(async(req,res)=>{const userId=await member(req);const {version,status,targetAmount,expiresAt,email}=req.body??{};if(status&&!['active','paused','booked','deleted'].includes(status))throw httpError('invalid_watch_status',400);await continuity.editWatch(userId,req.params.watchId,{version,status,targetAmount,...(expiresAt?{expiresAt:Date.parse(expiresAt)}:{}),email});res.json({status:'saved'});}));
  app.get('/api/notifications',asyncRoute(async(req,res)=>res.json(await continuity.notifications(await member(req)))));
  app.post('/api/notifications/:id/read',asyncRoute(async(req,res)=>{await continuity.markRead(await member(req),req.params.id);res.json({status:'saved'});}));
  app.get('/api/notification-email',asyncRoute(async(req,res)=>res.json(await continuity.emailStatus(await member(req)))));
  app.post('/api/notification-email',asyncRoute(async(req,res)=>{await continuity.requestEmail(await member(req),req.body?.email);res.json({status:'verification_sent'});}));
  app.delete('/api/notification-email',asyncRoute(async(req,res)=>{await continuity.removeEmail(await member(req));res.json({status:'removed'});}));
  app.post('/api/notification-email/verify',asyncRoute(async(req,res)=>{await continuity.verifyEmail(await member(req),req.body?.code);res.json({status:'verified'});}));
  app.post('/api/trips/:tripId/local-choice',asyncRoute(async(req,res)=>{await requireTripMember(req,req.params.tripId);const {baseRevision,nodeId,replaceNodeId,basePlanId}=req.body??{};res.json(await travelService.previewLocalChoice({tripId:req.params.tripId,baseRevision,nodeId,replaceNodeId,basePlanId}));}));
  app.post('/api/trips/:tripId/undo',asyncRoute(async(req,res)=>{await requireTripMember(req,req.params.tripId);res.json(await travelService.undoTripChange({tripId:req.params.tripId,changeId:req.body?.changeId,baseRevision:req.body?.baseRevision}));}));
  app.post('/api/trips/:tripId/requirements',asyncRoute(async(req,res)=>{
    await requireTripMember(req,req.params.tripId);const {baseRevision,requirements}=req.body??{};const state=await travelService.store.get(req.params.tripId);
    if(baseRevision!==state.revision)throw httpError('revision_conflict',409);
    if(!requirements||!Number.isInteger(requirements.travelerCount)||requirements.travelerCount<1||requirements.travelerCount>12)throw httpError('invalid_travelers',400);
    const {destination,dates,totalBudget,preferences}=requirements;
    res.json(await travelService.updateTripScope({tripId:req.params.tripId,brief:{destination,dates,totalBudget,preferences:Array.isArray(preferences)?preferences:String(preferences??'').split(/[；;\n]/).filter(Boolean)},travelerCount:requirements.travelerCount}, {expectedRevision:baseRevision}));
  }));
  let pending=null;const controller=new AbortController();const workerId=`watch_${randomUUID()}`;
  if(env.TRAVEL_AGENT_EXECUTION_ROLE!=='api'){
    const tick=()=>{if(pending)return;pending=(async()=>{for(let i=0;i<4;i++){if(!await continuity.checkDue(workerId,controller.signal))break;}await continuity.deliverEmail();})().catch(()=>{}).finally(()=>{pending=null});};
    const timer=setInterval(tick,30000);timer.unref();app.locals.continuityTimer=timer;
  }
  app.locals.continuity=continuity;
  return {async close(){clearInterval(app.locals.continuityTimer);controller.abort();await pending;await repository?.close()}};
}
