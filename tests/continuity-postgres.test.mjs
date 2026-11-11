import test from 'node:test';
import assert from 'node:assert/strict';
import{randomUUID}from'node:crypto';
import{Pool}from'pg';
import{ContinuityRepository}from'../src/persistence/continuity-repository.mjs';
import{TravelContinuityService}from'../travel-agent-pi-package/src/product/continuity.ts';
const input=process.env.TRAVEL_TEST_DATABASE_URL;
test('separate watch workers claim once and pausing invalidates an in-flight quote',{skip:!input},async()=>{
 const u=new URL(input);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.port==='55439'&&u.pathname==='/travel_plugin');const admin=new Pool({connectionString:input});const schema=`watch_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);u.searchParams.set('options',`-c search_path=${schema}`);const ra=new ContinuityRepository({databaseUrl:u.href}),rb=new ContinuityRepository({databaseUrl:u.href});let calls=0,release,entered;const waiting=new Promise(r=>{entered=r});const gate=new Promise(r=>{release=r});
 const conditions={kind:'hotel',provider:'fixture',providerRef:'room',dates:['2026-12-15','2026-12-16'],adults:1,childrenAges:[],rooms:1,product:'Twin',meal:'Breakfast',refund:'Refundable',baggage:'not_applicable',tax:'included',currency:'CNY',priceUnit:'per_booking'};
 const source={check:async()=>{calls++;entered();await gate;return{amount:800,checkedAt:Date.now(),conditions}}};const a=new TravelContinuityService(ra,source),b=new TravelContinuityService(rb,source);
 try{const w=await a.createWatch('owner',{tripId:'fixture-trip',nodeId:'fixture-node',title:'Controlled room',conditions,targetAmount:900,expiresAt:Date.now()+86400000,email:false});const first=a.checkDue('worker-A',new AbortController().signal);await waiting;assert.equal(await b.checkDue('worker-B',new AbortController().signal),false);assert.equal(calls,1);await b.editWatch('owner',w.watchId,{version:w.version,status:'paused'});release();await first;assert.equal((await b.notifications('owner')).length,0);const paused=(await b.watches('owner'))[0];assert.equal(paused.status,'paused');await b.editWatch('owner',w.watchId,{version:paused.version,status:'active'});await Promise.all([a.checkDue('worker-A',new AbortController().signal),b.checkDue('worker-B',new AbortController().signal)]);assert.equal(calls,2);assert.equal((await a.notifications('owner')).length,1);assert.equal((await b.notifications('other')).length,0);assert.equal((await a.watches('owner'))[0].lastQuote.amount,800);
 }finally{release();await Promise.all([ra.close(),rb.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
});
