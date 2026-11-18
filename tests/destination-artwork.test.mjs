import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { registerDestinationArtwork } from "../src/http/destination-artwork.mjs";
import { travelOperation } from "../src/mcp/operations.ts";
import { operationForPath } from "../src/web/travel-client.js";
import { createMcpHostBridge } from "../src/web/host-bridge.js";
import { destinationPaintingStyle, validDepthShapes } from "../src/media/destination-painting.js";
import { generateDestinationArtwork, artworkHostMode } from "../src/web/destination-artwork.js";
import { splitPaintingPixels } from "../src/web/painting-plates.js";
import { entryTemplate, suggestedJournalTemplate } from "../src/media/journal-templates.js";

const shapes = [{ depth: 4, points: [[0,.7],[.6,.55],[1,.88],[1,1],[0,1]] }];
const style = node => destinationPaintingStyle({domain:"play", ...node});

test("journal bindings use place-specific clues and retain the author's choice", () => {
  for (const [title, template] of [["黄山风景区","song"],["明孝陵","ming"],["Kew Gardens","british"],
    ["卢克索神庙","egyptian"],["Musée du Louvre","french"],["Roman Forum","roman"],["東海道","edo"],
    ["Naqsh-e Jahan","safavid"],["Tilantongo","mixtec"],["Bonwire","asante"]]) {
    assert.equal(suggestedJournalTemplate(title),template,title);
  }
  assert.equal(suggestedJournalTemplate("万神殿",{city:"罗马"}),"roman");
  assert.equal(suggestedJournalTemplate("市场旁的小巷",{city:"巴黎"}),"plain");
  assert.equal(suggestedJournalTemplate("黄山主题酒店"),"plain");
  assert.equal(entryTemplate({placeTitle:"黄山",templateId:"asante"}),"asante");
  assert.equal(entryTemplate({placeTitle:"黄山"}),"song");
});

test("the selected trip survives a tool result delivered before the embedded app subscribes", () => {
  const eventSource = new EventTarget();
  const target = { postMessage() {} };
  const bridge = createMcpHostBridge({ target, eventSource });
  function openTrip(conversationId) {
    const event = new Event("message");
    Object.assign(event, { source: target, data: {
      jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: { conversation: { conversationId } } },
    } });
    eventSource.dispatchEvent(event);
  }
  openTrip("first");
  openTrip("huangshan");
  const received = [];
  const unsubscribe = bridge.onResult(value => received.push(value.conversation.conversationId));
  openTrip("next");
  unsubscribe();
  openTrip("after-unmount");
  assert.deepEqual(received, ["huangshan", "next"]);
  bridge.dispose();
});

test("use the named place and corroborating site evidence, keep ordinary streets in pen and wash", () => {
  assert.equal(style({title:"古罗马广场"}).zh,"古迹建筑速写");
  assert.equal(style({title:"教堂",location:{city:"Rome"},evidenceSummary:{headline:"Renaissance architecture"}}).zh,"文艺复兴建筑素描");
  for (const node of [{title:"山间街道",location:{city:"拉萨"}},{title:"布达拉宫酒店"},{title:"新疆艺术展览"},{title:"Modern mall",location:{city:"Rome"}}]) assert.equal(style(node).zh,"钢笔淡彩");
  for (const [title,label] of [["克孜尔石窟","龟兹壁画色调"],["布达拉宫","藏式建筑矿彩"],["呼伦贝尔大草原","草原风景淡彩"],["黄山风景区","山水淡墨"]]) assert.equal(style({title}).zh,label);
});

test("a real image and valid model geometry are independently required from the host", async () => {
  const messages=[], eventSource=new EventTarget(), target={postMessage(message){
    if (!message.id) return;
    messages.push(message);
    const result = message.method==="ui/initialize" ? {hostCapabilities:{sampling:{}}} : messages.length===2 ? {content:{type:"image",mimeType:"image/jpeg",data:"YWJj"}} : {content:{type:"text",text:JSON.stringify({shapes})}};
    queueMicrotask(()=>{const event=new Event("message"); Object.assign(event,{source:target,data:{id:message.id,jsonrpc:"2.0",result}}); eventSource.dispatchEvent(event);});
  }};
  const host=createMcpHostBridge({target,eventSource}); await host.initialize();
  const input={photo:{data:"ZWZn"},style:style({title:"巴黎"}),signal:new AbortController().signal,onDepth(){},host};
  const result=await generateDestinationArtwork(input);
  assert.equal(messages[1].params.messages[0].content[1].data,input.photo.data);
  assert.equal(messages[2].params.messages[0].content[1].data,"YWJj");
  assert.deepEqual(result.shapes,shapes);
  host.dispose();
  assert.equal(artworkHostMode({},{}),null);
  await assert.rejects(generateDestinationArtwork({...input, host:{supportsSampling:true,sample: async()=>({content:{type:"text",text:"done"}})}}), /no_image/);
  assert.equal(validDepthShapes([{ depth:2, points:[[.2,.2],[.2,.2],[.2,.2]] }]), false);
});

test("neutral plates reproduce all visible pixels and reveal bounded fill below shifted silhouettes", () => {
  const w=10,h=5, depths=Uint8Array.from({length:w*h},(_,i)=>i%w>4?4:0);
  const pixels=Uint8ClampedArray.from({length:w*h*4},(_,i)=>i%4===3?255:depths[Math.floor(i/4)]?70:22);
  const layers=splitPaintingPixels(pixels,depths,w,h,2);
  assert.deepEqual(layers.map(l=>l.depth),[0,4]);
  for (let i=0;i<w*h;i++){
    const visible = layers.findLast(layer=>layer.colors[i*4+3]);
    assert.deepEqual(visible.colors.slice(i*4,i*4+4),pixels.slice(i*4,i*4+4));
  }
  assert.deepEqual([...layers[0].colors.slice(6*4,6*4+4)],[22,22,22,255]);
  assert.equal(layers[0].colors[7*4+3],0);
  assert.throws(()=>splitPaintingPixels(pixels,new Uint8Array(w*h),w,h,1),/depth_invalid/);
});

test("place preview rendezvous requires the same viewer, trip and request; late results expire", async () => {
  let now=0;
  const app=express(); app.use(express.json());
  registerDestinationArtwork({app,clock:()=>new Date(now),asyncRoute:fn=>(q,s,n)=>fn(q,s).catch(n),requireTripMember:async req=>({userId:req.get("Test-User")})});
  app.use((error,q,s,n)=>s.status(error.status??500).json({code:error.code}));
  const server=app.listen(0,"127.0.0.1"); await once(server,"listening");
  try {
    const id=randomUUID(),path="/api/trips/test/artwork/"+id;
    const request=(method,suffix="",body,user="a")=>fetch("http://127.0.0.1:"+server.address().port+path+suffix,{method,headers:{"Content-Type":"application/json","Test-User":user},body:body?JSON.stringify(body):undefined});
    for(const method of ["GET","DELETE","POST"]){ const op=operationForPath(path,method); assert.equal(travelOperation(op.action,op.args).path,path); }
    assert.equal((await request("POST")).status,200);
    const payload={fileId:"file_generated",shapes};
    assert.equal((await request("POST","/complete",payload,"b")).status,404);
    assert.equal((await request("POST","/complete",{fileId:"file",shapes:[]})).status,400);
    assert.equal((await request("POST","/complete",payload)).status,200);
    assert.deepEqual(await (await request("GET")).json(),{status:"ready",...payload});
    assert.equal((await request("POST","/complete",{unavailable:true})).status,409);
    now=700000; assert.equal((await request("GET")).status,404);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
