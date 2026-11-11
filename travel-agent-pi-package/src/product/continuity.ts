import { createHash, randomUUID, randomInt } from "node:crypto";
import type { SqlResult } from "../dsh/postgres-session.js";
export interface ProductConnection { query(sql: string, values?: unknown[]): Promise<SqlResult> }
export interface ProductRepository extends ProductConnection { mode: string; transaction<T>(task: (c: ProductConnection) => Promise<T>): Promise<T> }
export const PRODUCT_SQL = `
CREATE TABLE IF NOT EXISTS travel_preferences (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, items_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS travel_price_watches (watch_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,definition_json TEXT NOT NULL,last_quote_json TEXT,next_check BIGINT NOT NULL,lease_until BIGINT NOT NULL DEFAULT 0,worker_id TEXT,fence INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_notified_amount DOUBLE PRECISION);
CREATE INDEX IF NOT EXISTS travel_price_watches_due ON travel_price_watches(status,next_check);
CREATE TABLE IF NOT EXISTS travel_notifications (notification_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,watch_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,content_json TEXT NOT NULL,created_at BIGINT NOT NULL,read_at BIGINT);
CREATE TABLE IF NOT EXISTS travel_notification_email (user_id TEXT PRIMARY KEY,email TEXT NOT NULL,verified_at BIGINT,code_hash TEXT,code_expires BIGINT,attempts INTEGER NOT NULL DEFAULT 0,last_sent BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS travel_email_outbox (event_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at BIGINT NOT NULL,lease_until BIGINT NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,provider_id TEXT);
`;
const fail = (code: string): never => { throw Object.assign(new Error(code),{code,status:code==="revision_conflict"?409:code.endsWith("not_found")?404:code==="email_provider_not_configured"?503:400}); };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function cleanText(v: unknown,max=400): string { if(typeof v!=="string"||!v.trim()||v.length>max||/(?:cookie|token|password|authorization|api[_ -]?key)\s*[:=]|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{15,19}\b|(?:\+?\d[ -]?){11,}/i.test(v)) return fail("invalid_preference"); return v.trim(); }
export interface Preference { id: string; text: string; context: string; origin: "explicit"|"inferred"; confirmed: boolean; basis?: string; updatedAt: number }
export interface WatchConditions { kind: "hotel"|"flight"; provider: string; providerRef: string; dates: string[]; adults: number; childrenAges: number[]; rooms: number|null; product: string; meal: string; refund: string; baggage: string; tax: string; currency: string; priceUnit: string }
export interface WatchDefinition { tripId: string; nodeId: string; title: string; conditions: WatchConditions; targetAmount: number; expiresAt: number; email: boolean }
export interface WatchQuote { amount: number; checkedAt: number; conditions: WatchConditions; bookingUrl?: string }
export interface PriceWatch extends WatchDefinition { watchId: string; version: number; status: string; ownerUserId: string; lastQuote: WatchQuote|null; nextCheck: number; lastError: string|null }
export interface Mailer { send(input: {to:string;subject:string;text:string;key:string}):Promise<{id:string}> }
export interface QuoteSource { check(watch: WatchDefinition & {ownerUserId?: string},signal: AbortSignal):Promise<WatchQuote> }
function canonical(c: WatchConditions): string {
  if(!["hotel","flight"].includes(c.kind)||!c.provider||!c.providerRef||!Array.isArray(c.dates)||c.dates.length!==2||c.dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)||c.dates[1]!<c.dates[0]!||!Number.isInteger(c.adults)||c.adults<1||!Array.isArray(c.childrenAges)||c.childrenAges.some(v=>!Number.isInteger(v)||v<0||v>17)||!c.product||!c.refund||!c.tax||!/^[A-Z]{3}$/.test(c.currency)||!["per_booking","per_order"].includes(c.priceUnit)||(c.kind==='hotel'&&(!c.rooms||!c.meal))||(c.kind==='flight'&&!c.baggage)) return fail("watch_conditions_incomplete");
  return JSON.stringify([c.kind,c.provider,c.providerRef,c.dates,c.adults,c.childrenAges,c.rooms,c.product,c.meal,c.refund,c.baggage,c.tax,c.currency,c.priceUnit]);
}
export function sameWatchConditions(left:WatchConditions,right:WatchConditions):boolean { return canonical(left)===canonical(right); }
export class TravelContinuityService {
  constructor(private readonly repo:ProductRepository,private readonly quoteSource:QuoteSource,private readonly mailer?:Mailer,private readonly clock:()=>number=Date.now) {}
  private async now(c:ProductConnection=this.repo):Promise<number> { return this.repo.mode==='postgres'?Number((await c.query("SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now")).rows[0]?.now):this.clock(); }
  async preferences(userId:string):Promise<{enabled:boolean;revision:number;items:Preference[]}> {
    const r=await this.repo.query("SELECT * FROM travel_preferences WHERE user_id=$1",[userId]);const row=r.rows[0];return row?{enabled:Boolean(row.enabled),revision:Number(row.revision),items:JSON.parse(String(row.items_json)) as Preference[]}:{enabled:false,revision:0,items:[]};
  }
  async changePreferences(userId:string,input:{revision:number;enabled?:boolean;text?:string;context?:string;origin?:"explicit"|"inferred";confirm?:boolean;id?:string;remove?:boolean}):Promise<Awaited<ReturnType<TravelContinuityService["preferences"]>>> {
    return this.repo.transaction(async c=>{
      await c.query("INSERT INTO travel_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING",[userId]);
      const row=(await c.query("SELECT * FROM travel_preferences WHERE user_id=$1 FOR UPDATE",[userId])).rows[0]!;
      if(Number(row.revision)!==input.revision)return fail("revision_conflict");
      let enabled=Boolean(row.enabled);let items=JSON.parse(String(row.items_json)) as Preference[];
      if(input.enabled!==undefined)enabled=input.enabled;
      if(input.remove){items=items.filter(p=>p.id!==input.id);}
      else if(input.text!==undefined){
        if(!enabled)return fail("preference_memory_disabled");
        const origin=input.origin??"explicit";
        if(origin==='inferred'&&input.confirm!==true)return fail("preference_confirmation_required");
        const item:Preference={id:input.id??randomUUID(),text:cleanText(input.text),context:input.context?cleanText(input.context,200):"general",origin,confirmed:true,updatedAt:await this.now(c)};
        if(!input.id&&items.some(p=>p.confirmed&&p.text===item.text&&p.context===item.context))return {enabled,revision:Number(row.revision),items};
        if(input.id&&!items.some(p=>p.id===input.id))return fail("preference_not_found");
        items=[...items.filter(p=>p.id!==item.id),item];if(items.length>100)return fail("preference_limit");
      }
      await c.query("UPDATE travel_preferences SET enabled=$2,revision=revision+1,items_json=$3 WHERE user_id=$1",[userId,enabled?1:0,JSON.stringify(items)]);
      return {enabled,revision:Number(row.revision)+1,items};
    });
  }
  async suggestPreference(userId:string,text:string,basis:string):Promise<void>{
    text=cleanText(text);basis=cleanText(basis,300);
    await this.repo.transaction(async c=>{const row=(await c.query("SELECT * FROM travel_preferences WHERE user_id=$1 FOR UPDATE",[userId])).rows[0];if(!row||!row.enabled)return;const items=JSON.parse(String(row.items_json)) as Preference[];if(items.some(p=>p.text===text)||items.length>=100)return;items.push({id:randomUUID(),text,context:"general",origin:"inferred",confirmed:false,basis,updatedAt:await this.now(c)});await c.query("UPDATE travel_preferences SET revision=revision+1,items_json=$2 WHERE user_id=$1",[userId,JSON.stringify(items)]);});
  }
  async confirmPreference(userId:string,id:string,revision:number):Promise<void>{
    await this.repo.transaction(async c=>{const row=(await c.query("SELECT * FROM travel_preferences WHERE user_id=$1 FOR UPDATE",[userId])).rows[0];if(!row||!row.enabled)return fail("preference_memory_disabled");if(Number(row.revision)!==revision)return fail("revision_conflict");const items=JSON.parse(String(row.items_json)) as Preference[];const item=items.find(p=>p.id===id);if(!item)return fail("preference_not_found");item.confirmed=true;item.updatedAt=await this.now(c);await c.query("UPDATE travel_preferences SET revision=revision+1,items_json=$2 WHERE user_id=$1",[userId,JSON.stringify(items)]);});
  }
  async applicablePreferences(userId:string,context="general"):Promise<Preference[]> { const p=await this.preferences(userId);return p.enabled?p.items.filter(p=>p.context==='general'||p.context===context).filter(p=>p.confirmed):[]; }
  private watch(row:Record<string,unknown>):PriceWatch { return {...JSON.parse(String(row.definition_json)) as WatchDefinition,watchId:String(row.watch_id),ownerUserId:String(row.user_id),version:Number(row.version),status:String(row.status),lastQuote:row.last_quote_json?JSON.parse(String(row.last_quote_json)) as WatchQuote:null,nextCheck:Number(row.next_check),lastError:row.last_error?String(row.last_error):null}; }
  async watches(userId:string):Promise<PriceWatch[]> { const r=await this.repo.query("SELECT * FROM travel_price_watches WHERE user_id=$1 ORDER BY next_check",[userId]);return r.rows.map(r=>this.watch(r)); }
  async recheckWatch(userId:string,id:string,signal:AbortSignal):Promise<WatchQuote>{
    const row=(await this.repo.query("SELECT * FROM travel_price_watches WHERE watch_id=$1 AND user_id=$2 AND status NOT IN ('deleted','booked')",[id,userId])).rows[0];
    if(!row)return fail('watch_not_found');
    const watch=this.watch(row);const quote=await this.quoteSource.check(watch,AbortSignal.any([signal,AbortSignal.timeout(45000)]));
    if(!sameWatchConditions(watch.conditions,quote.conditions))return fail('watch_conditions_changed');
    const now=await this.now();if(!Number.isFinite(quote.amount)||quote.amount<0||quote.checkedAt<now-300000||quote.checkedAt>now+60000)return fail('quote_not_fresh');
    let bookingUrl:string|undefined;try{const url=new URL(quote.bookingUrl??'');if(url.protocol==='https:'&&!url.username&&!url.password)bookingUrl=url.href;}catch{/* A quote can be valid without a supplier link. */}
    const {bookingUrl: ignored,...fresh}=quote;
    return {...fresh,...(bookingUrl?{bookingUrl}:{})};
  }
  async createWatch(userId:string,definition:WatchDefinition,requestId?:string):Promise<PriceWatch> {
    canonical(definition.conditions); const now=await this.now();
    if(!Number.isFinite(definition.targetAmount)||definition.targetAmount<=0||definition.targetAmount>1e8||definition.expiresAt<=now||definition.expiresAt>now+366*86400000)return fail("invalid_watch_target");
    cleanText(definition.title,200);if(!definition.tripId||!definition.nodeId)return fail("invalid_watch_target");
    if(requestId!==undefined&&(typeof requestId!=='string'||! /^[A-Za-z0-9_.:-]{8,128}$/.test(requestId)))return fail("invalid_watch_target");
    const watchId=requestId?`watch_${hash([userId,requestId])}`:randomUUID();
    await this.repo.transaction(async c=>{if(this.repo.mode==='postgres')await c.query("SELECT pg_advisory_xact_lock(715803128,hashtext($1))",[userId]);const previous=(await c.query("SELECT definition_json FROM travel_price_watches WHERE watch_id=$1 AND user_id=$2",[watchId,userId])).rows[0];if(previous){if(hash(JSON.parse(String(previous.definition_json)))!==hash(definition))return fail('operation_id_conflict');return;}if(Number((await c.query("SELECT COUNT(*) AS count FROM travel_price_watches WHERE user_id=$1 AND status='active'",[userId])).rows[0]?.count)>=50)return fail("watch_limit");await c.query("INSERT INTO travel_price_watches(watch_id,user_id,status,definition_json,next_check) VALUES($1,$2,'active',$3,$4) ON CONFLICT(watch_id) DO NOTHING",[watchId,userId,JSON.stringify(definition),now]);const saved=(await c.query("SELECT definition_json FROM travel_price_watches WHERE watch_id=$1 AND user_id=$2",[watchId,userId])).rows[0];if(!saved||hash(JSON.parse(String(saved.definition_json)))!==hash(definition))return fail('operation_id_conflict');});
    return (await this.watches(userId)).find(w=>w.watchId===watchId)!;
  }
  async editWatch(userId:string,id:string,input:{version:number;status?:"active"|"paused"|"booked"|"deleted";targetAmount?:number;expiresAt?:number;email?:boolean}):Promise<void> {
    await this.repo.transaction(async c=>{const row=(await c.query("SELECT * FROM travel_price_watches WHERE watch_id=$1 AND user_id=$2 FOR UPDATE",[id,userId])).rows[0];if(!row)return fail("watch_not_found");if(Number(row.version)!==input.version)return fail("revision_conflict");const d=JSON.parse(String(row.definition_json)) as WatchDefinition;
      if(input.targetAmount!==undefined){if(!Number.isFinite(input.targetAmount)||input.targetAmount<=0)return fail("invalid_watch_target");d.targetAmount=input.targetAmount;}
      if(input.expiresAt!==undefined){const now=await this.now(c);if(input.expiresAt<=now||input.expiresAt>now+366*86400000)return fail("invalid_watch_target");d.expiresAt=input.expiresAt;}
      if(input.email!==undefined)d.email=input.email;
      if(['booked','deleted'].includes(String(row.status))&&input.status==='active')return fail('watch_already_ended');
      await c.query("UPDATE travel_price_watches SET status=$3,definition_json=$4,version=version+1,fence=fence+1,worker_id=NULL,lease_until=0,next_check=$5 WHERE watch_id=$1 AND user_id=$2",[id,userId,input.status??row.status,JSON.stringify(d),await this.now(c)]);
    });
  }
  async notifications(userId:string):Promise<Record<string,unknown>[]> { const r=await this.repo.query("SELECT n.*,m.status AS email_status FROM travel_notifications n LEFT JOIN travel_email_outbox m ON m.event_key=n.event_key AND m.user_id=n.user_id WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 100",[userId]);return r.rows.map(r=>({notificationId:r.notification_id,watchId:r.watch_id,createdAt:Number(r.created_at),read:!!r.read_at,emailStatus:r.email_status??null,content:JSON.parse(String(r.content_json)) as unknown})); }
  async markRead(userId:string,id:string):Promise<void>{await this.repo.query("UPDATE travel_notifications SET read_at=$3 WHERE notification_id=$1 AND user_id=$2",[id,userId,await this.now()]);}
  async emailStatus(userId:string):Promise<{address:string|null;verified:boolean;available:boolean}>{const r=(await this.repo.query("SELECT email,verified_at FROM travel_notification_email WHERE user_id=$1",[userId])).rows[0];return{address:r?String(r.email):null,verified:!!r?.verified_at,available:!!this.mailer};}
  async requestEmail(userId:string,email:string):Promise<void>{
    if(!this.mailer)return fail("email_provider_not_configured");if(typeof email!=="string"||email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return fail("invalid_email");
    const code=String(randomInt(100000,1000000));const now=await this.now();const key=randomUUID();
    await this.repo.transaction(async c=>{await c.query("INSERT INTO travel_notification_email(user_id,email) VALUES($1,$2) ON CONFLICT DO NOTHING",[userId,email]);const old=(await c.query("SELECT last_sent FROM travel_notification_email WHERE user_id=$1 FOR UPDATE",[userId])).rows[0];if(old&&Number(old.last_sent)>now-60000)return fail("email_rate_limited");await c.query("INSERT INTO travel_notification_email(user_id,email,code_hash,code_expires,last_sent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET email=$2,verified_at=NULL,code_hash=$3,code_expires=$4,attempts=0,last_sent=$5",[userId,email,hash([userId,code]),now+600000,now]);});
    // A failed or unknown send never verifies an address. A new request is a new
    // challenge; no automatic resend can duplicate an uncertain external effect.
    await this.mailer.send({to:email,subject:"验证旅行价格提醒邮箱",text:`你的验证码是 ${code}，10 分钟内有效。`,key:`travel-verify/${key}`});
  }
  async removeEmail(userId:string):Promise<void>{await this.repo.transaction(async c=>{await c.query("DELETE FROM travel_notification_email WHERE user_id=$1",[userId]);await c.query("UPDATE travel_email_outbox SET status='cancelled' WHERE user_id=$1 AND status='pending'",[userId]);});}
  async verifyEmail(userId:string,code:string):Promise<void>{
    const valid=await this.repo.transaction(async c=>{const row=(await c.query("SELECT * FROM travel_notification_email WHERE user_id=$1 FOR UPDATE",[userId])).rows[0];if(!row||Number(row.attempts)>=5||Number(row.code_expires)<await this.now(c))return false;
      if(row.code_hash!==hash([userId,code])){await c.query("UPDATE travel_notification_email SET attempts=attempts+1 WHERE user_id=$1",[userId]);return false;}
      await c.query("UPDATE travel_notification_email SET verified_at=$2,code_hash=NULL,code_expires=NULL WHERE user_id=$1",[userId,await this.now(c)]);return true;});if(!valid)return fail("invalid_verification_code");
  }
  async checkDue(workerId:string,signal:AbortSignal):Promise<boolean>{
    const claim=await this.repo.transaction(async c=>{const now=await this.now(c);const row=(await c.query(`SELECT * FROM travel_price_watches WHERE status='active' AND next_check<=$1 AND lease_until<$1 ORDER BY next_check LIMIT 1${this.repo.mode==='postgres'?' FOR UPDATE SKIP LOCKED':''}`,[now])).rows[0];if(!row)return null;
      const d=JSON.parse(String(row.definition_json)) as WatchDefinition;if(d.expiresAt<=now){await c.query("UPDATE travel_price_watches SET status='expired',version=version+1 WHERE watch_id=$1",[row.watch_id]);return null;}
      await c.query("UPDATE travel_price_watches SET worker_id=$2,lease_until=$3,fence=fence+1 WHERE watch_id=$1",[row.watch_id,workerId,now+60000]);return {...row,fence:Number(row.fence)+1} as Record<string,unknown> & {fence:number};});
    if(!claim)return false;const watch=this.watch(claim);let quote:WatchQuote|undefined;let error:string|null=null;
    try {quote=await this.quoteSource.check(watch,AbortSignal.any([signal,AbortSignal.timeout(45000)]));if(!sameWatchConditions(watch.conditions,quote.conditions))return fail("watch_conditions_changed");if(!Number.isFinite(quote.amount)||quote.amount<0||quote.checkedAt<await this.now()-300000||quote.checkedAt>await this.now()+60000)return fail("quote_not_fresh");}catch(e){quote=undefined;error=e instanceof Error?(['watch_conditions_changed','quote_not_fresh','quote_unavailable','trip_access_revoked'].includes(e.message)?e.message:'quote_source_unavailable'):'quote_source_unavailable';}
    await this.repo.transaction(async c=>{const now=await this.now(c);const row=(await c.query("SELECT * FROM travel_price_watches WHERE watch_id=$1 AND worker_id=$2 AND fence=$3 AND status='active' AND lease_until>$4 FOR UPDATE",[watch.watchId,workerId,claim.fence,now])).rows[0];if(!row)return;
      if(watch.expiresAt<=now){await c.query("UPDATE travel_price_watches SET status='expired',worker_id=NULL,lease_until=0 WHERE watch_id=$1",[watch.watchId]);return;}
      if(quote&&quote.amount<=watch.targetAmount&&(row.last_notified_amount==null||quote.amount<Number(row.last_notified_amount))){
        const eventKey=hash([watch.watchId,watch.conditions,quote.amount]);const content={title:watch.title,amount:quote.amount,targetAmount:watch.targetAmount,currency:watch.conditions.currency,conditions:watch.conditions,checkedAt:quote.checkedAt,tripId:watch.tripId,nodeId:watch.nodeId};
        const inserted=await c.query("INSERT INTO travel_notifications(notification_id,user_id,watch_id,event_key,content_json,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[randomUUID(),claim.user_id,watch.watchId,eventKey,JSON.stringify(content),now]);
        if(inserted.rowCount&&watch.email){const recipient=(await c.query("SELECT email FROM travel_notification_email WHERE user_id=$1 AND verified_at IS NOT NULL",[claim.user_id])).rows[0];if(recipient)await c.query("INSERT INTO travel_email_outbox(event_key,user_id,payload_json,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[eventKey,claim.user_id,JSON.stringify({to:recipient.email,subject:`${watch.title}已达到目标价`,text:`相同条件下的最新价格为 ${quote.amount} ${watch.conditions.currency}，目标 ${watch.targetAmount}。查询时间 ${new Date(quote.checkedAt).toISOString()}。请重新打开旅行插件核对最新价格，购买由你确认。`}),now]);}
        await c.query("UPDATE travel_price_watches SET last_notified_amount=$2 WHERE watch_id=$1",[watch.watchId,quote.amount]);
      }
      await c.query("UPDATE travel_price_watches SET last_quote_json=COALESCE($2,last_quote_json),last_error=$3,next_check=$4,worker_id=NULL,lease_until=0 WHERE watch_id=$1",[watch.watchId,quote?JSON.stringify(quote):null,error,now+(error?3600000:86400000)]);
    });return true;
  }
  async deliverEmail():Promise<boolean>{
    if(!this.mailer)return false;
    const row=await this.repo.transaction(async c=>{const now=await this.now(c);const r=(await c.query(`SELECT * FROM travel_email_outbox WHERE status IN ('pending','sending') AND lease_until<$1 ORDER BY created_at LIMIT 1${this.repo.mode==='postgres'?' FOR UPDATE SKIP LOCKED':''}`,[now])).rows[0];if(!r)return null;
      const recipient=(await c.query("SELECT email FROM travel_notification_email WHERE user_id=$1 AND verified_at IS NOT NULL",[r.user_id])).rows[0];
      if(!recipient||recipient.email!==(JSON.parse(String(r.payload_json)) as {to:string}).to){await c.query("UPDATE travel_email_outbox SET status='cancelled' WHERE event_key=$1",[r.event_key]);return null;}
      // Resend keeps keys for 24h. Unknown deliveries beyond that window must
      // never be retried under a fresh key (manual provider reconciliation).
      if(Number(r.created_at)<now-23*3600000){await c.query("UPDATE travel_email_outbox SET status='unknown' WHERE event_key=$1",[r.event_key]);return null;}
      await c.query("UPDATE travel_email_outbox SET status='sending',lease_until=$2,attempts=attempts+1 WHERE event_key=$1",[r.event_key,now+60000]);return r;});
    if(!row)return false;const payload=JSON.parse(String(row.payload_json)) as {to:string;subject:string;text:string};
    try {const receipt=await this.mailer.send({...payload,key:`travel-price/${String(row.event_key)}`});await this.repo.query("UPDATE travel_email_outbox SET status='sent',provider_id=$2,lease_until=0 WHERE event_key=$1",[row.event_key,receipt.id]);}
    catch {await this.repo.query("UPDATE travel_email_outbox SET lease_until=$2 WHERE event_key=$1",[row.event_key,await this.now()+60000]);}return true;
  }
}
