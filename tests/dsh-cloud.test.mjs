import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{Pool}from'pg';
import{createTravelCloudApp}from'../src/dsh/cloud-app.mjs';
const input=process.env.TRAVEL_TEST_DATABASE_URL;
test('DSH cloud composition serves the real authenticated API and another instance reads saved preferences',{skip:!input},async()=>{
 const u=new URL(input);assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.port==='55439'&&u.pathname==='/travel_plugin');const bootstrap=new Pool({connectionString:input});const schema=`cloud_${randomUUID().replaceAll('-','')}`;await bootstrap.query(`CREATE SCHEMA "${schema}"`);u.searchParams.set('options',`-c search_path=${schema}`);const root=await mkdtemp(join(tmpdir(),'travel-cloud-test-'));let a,b,server;
 try{
 const env={NODE_ENV:'test',DATABASE_URL:u.toString(),TRAVEL_AGENT_DATA_DIR:root,TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH:'true',TRAVEL_AGENT_EXECUTION_ROLE:'api',TRAVEL_AGENT_OPEN_METEO_ENABLED:'false'};a=await createTravelCloudApp(env);server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(origin+'/api/health')).status,200);const login=await fetch(origin+'/api/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'email_otp',identity:'cloud-fixture@example.test'})});assert.equal(login.status,201);const cookie=login.headers.get('set-cookie').split(';')[0];const req=(path,body)=>fetch(origin+path,{method:body?'POST':'GET',headers:{Cookie:cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const saved=await req('/api/preferences',{revision:0,enabled:true,text:'Prefer twin beds'});assert.equal(saved.status,200);const p=await saved.json();assert.equal(p.items[0].text,'Prefer twin beds');b=await createTravelCloudApp(env);assert.equal((await b.app.locals.continuity.preferences((await login.json()).userId)).items[0].text,'Prefer twin beds');
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await b?.close();await a?.close();await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);await bootstrap.end();await rm(root,{recursive:true,force:true})}
});
