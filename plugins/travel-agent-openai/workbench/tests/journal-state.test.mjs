import test from "node:test";
import assert from "node:assert/strict";
import { newJournalDraft, editJournalDraft, journalSaveArguments, sameRelief } from "../src/journal-state.mjs";
test("a date or visit can start a text memory without temporary place references", () => {
  const draft = newJournalDraft({date:"2026-11-21",stopId:"visit-2",name:"散步"});
  draft.note="累了就坐下来";
  const input=journalSaveArguments("trip",8,draft,"same-save");
  assert.equal(input.expectedEntryRevision,-1); assert.equal(input.visitStopId,"visit-2"); assert.equal(input.takenOn,"2026-11-21");
  assert.deepEqual(input.photos,[]); assert.equal(input.note,"累了就坐下来"); assert.equal(input.resultId,undefined);
});
test("editing reorders stable photos without resending originals and clears effects for food", () => {
  const recipe={version:"photo-relief-v1",style:"ink",horizon:.5,depth:.6};
  const entry={entryId:"entry",entryRevision:4,title:"屋檐",subject:"building",stage:"visited",photos:[{photoId:"first",relief:recipe},{photoId:"second"}]};
  const draft=editJournalDraft(entry); draft.photos.reverse();
  const edited=journalSaveArguments("trip",8,draft,"save");
  assert.deepEqual(edited.photos.map(p=>p.photoId),["second","first"]); assert.equal(edited.expectedEntryRevision,4);
  assert.equal(edited.photos[1].data,undefined); assert.deepEqual(edited.photos[1].relief,recipe);
  draft.subject="food";
  assert.deepEqual(journalSaveArguments("trip",8,draft,"save-food").photos,[{photoId:"second",relief:null},{photoId:"first",relief:null}]);
  assert.equal(entry.photos[0].photoId,"first");
  assert.equal(sameRelief(recipe,{...recipe}),true); assert.equal(sameRelief(recipe,{...recipe,depth:.8}),false);
});
test("the production host bridge returns app-only journal payloads rather than the public status summary", async () => {
  const { TravelHostPort } = await import("../src/host-port.mjs");
  const privateData={status:"saved",entry:{entryId:"memory",note:"private text",photos:[{photoId:"stable"}]}};
  const port=new TravelHostPort({callServerTool:async ({name})=>name==="get_profile"?{structuredContent:{id:"owner"}}:{structuredContent:{status:"ok"},_meta:{"travel/uiData":privateData}}});
  for(const tool of ["get_trip_journal_entry","read_trip_journal_image","save_trip_journal_entry","save_trip_photo_relief"]) assert.deepEqual(await port.call(tool,{tripId:"trip"}),privateData);
});
