import { Context, Service } from '@deepseek-ai/cordis';
import { createTravelService } from '../api/create-travel-service.mjs';
import { createHttpApp } from '../http/app.mjs';

/** Dedicated DSH travel composition. No Coding bundle or owner/admin API. */
export async function createTravelCloudApp(env,{listen=false}={}){
 const ctx=new Context();let app,server;
 class TravelBusiness extends Service{
  constructor(c){super(c,'travelBusiness');this.travelService=createTravelService(env);}
 }
 const business=await ctx.plugin(TravelBusiness);
 const gateway=await ctx.plugin({name:'travel-cloud-gateway',inject:['travelBusiness'],apply(c){
  app=createHttpApp({travelService:c.travelBusiness.travelService,runtimeEnv:env,developmentAuthEnabled:env.NODE_ENV!=='production'&&env.TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH==='true',allowedOrigins:new Set(String(env.TRAVEL_AGENT_CORS_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean))});
  c.effect(()=>async()=>{if(server){await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();const timer=setTimeout(()=>server.closeAllConnections(),5000);timer.unref()})}await app.locals.close();await c.travelBusiness.travelService.store.close?.()});
 }});
 if(!app)throw new Error('dsh_travel_gateway_not_ready');
 if(listen){server=app.listen(Number(env.PORT??8797),env.TRAVEL_AGENT_BIND_HOST??'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});server.ref()}
 return {app,server,context:ctx,async close(){await gateway.dispose();await business.dispose()}};
}
