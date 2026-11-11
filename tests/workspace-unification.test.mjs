import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { createTravelAnalysisRunCoordinator } from "../src/agent/travel-analysis-run-coordinator.mjs";
import { planningProvider, planningResponse } from "./fixtures/jev-planning.mjs";
import { buildDraftReview } from "../travel-agent-pi-package/src/core/workspace-review.ts";
import { TravelContinuityService } from "../travel-agent-pi-package/src/product/continuity.ts";
import { ContinuityRepository } from "../src/persistence/continuity-repository.mjs";
import { withTravelActor } from "../travel-agent-pi-package/src/host/execution-context.ts";
import { TravelJournalRepository } from "../src/persistence/travel-journal-repository.mjs";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
import { AuthRepository } from "../src/persistence/auth-repository.mjs";
import { AccountService } from "../src/http/account-service.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { TravelService } from "../src/api/travel-service.mjs";
import { createHttpApp } from "../src/http/app.mjs";
const database = process.env.TRAVEL_TEST_DATABASE_URL;
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAA//2Q==";
const digest = email => createHash("sha256").update(`travel-share-email-v1:${email}`).digest("hex");
const recipe = { version: "photo-relief-v1", horizon: .48, depth: .65, style: "ink" };
async function fixture(t) {
  const url = new URL(database);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "55439" && url.pathname === "/travel_plugin", "dedicated local validation database required");
  const admin = new Pool({ connectionString: url.href }), schema = `workspace_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set("options", `-c search_path=${schema}`);
  const store = new PostgresTripRepository({ databaseUrl: url.href });
  const auth = new AuthRepository({ databaseUrl: url.href }), accounts = new AccountService({ repository: auth });
  const people = {};
  for (const name of ["owner", "viewer", "other"]) {
    const userId = await accounts.resolveIdentity({ provider: "google", subject: `${schema}_${name}`, displayName: name, email: `${name}@example.test`, emailVerified: true });
    people[name] = { userId, token: (await accounts.issue({ userId, provider: "google" })).opaqueToken };
  }
  const service = new TravelService({ store });
  const trip = await service.createTrip({ ownerUserId: people.owner.userId, brief: { destination: "受控旅行" } });
  const app = createHttpApp({ travelService: service, accountService: accounts, runtimeEnv: { NODE_ENV: "test", DATABASE_URL: url.href, TRAVEL_AGENT_EXECUTION_ROLE: "api", TRAVEL_AGENT_PUBLIC_ORIGIN: "https://travel.test" }, developmentAuthEnabled: false });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.locals.close(); await auth.close(); await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const call = async (who, action, args = {}, tripId = trip.tripId) => {
    const response = await fetch(`${base}/api/trips/${tripId}/workspace/${action}`, { method: "POST", headers: { Authorization: `Bearer ${people[who].token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return { status: response.status, body: await response.json() };
  };
  const save = (changes = {}) => ({ expectedRevision: 0, requestId: randomUUID(), entryId: randomUUID(), expectedEntryRevision: -1, title: "", note: "今天慢慢走", takenOn: "2026-11-21", subject: "landscape", stage: "visited", photos: [], ...changes });
  const grant = async role => {
    const found = await call("owner", "resolve_trip_share_email", { emailHash: digest("viewer@example.test") }); assert.equal(found.status, 200);
    return call("owner", "grant_trip_share_email", { accountId: found.body.accountId, emailHash: digest("viewer@example.test"), expectedAccessRevision: found.body.accessRevision, role, requestId: randomUUID() });
  };
  return { call, save, grant, people, service, store, accounts, auth, oauth: app.locals.mcpOAuth, databaseUrl: url.href, tripId: trip.tripId, base };
}

test("one cloud journal accepts text without a place, reopens, edits with versions and never resurrects a deleted entry", { skip: !database }, async t => {
  const f = await fixture(t), before = await f.store.get(f.tripId), command = f.save();
  const saved = await f.call("owner", "save_trip_journal_entry", command); assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.body.entry.note, command.note); assert.equal(saved.body.entry.entryRevision, 0);
  const list = await f.call("owner", "list_trip_journal"); assert.equal(list.body.items[0].entryId, command.entryId);
  const edit = f.save({ ...command, note: "修改后的文字", expectedEntryRevision: 0, requestId: randomUUID() });
  assert.equal((await f.call("owner", "save_trip_journal_entry", edit)).body.entry.entryRevision, 1);
  assert.equal((await f.call("owner", "save_trip_journal_entry", { ...edit, requestId: randomUUID() })).status, 409);
  const recovered = await f.call("owner", "save_trip_journal_entry", command);
  assert.equal(recovered.body.entry.note, edit.note); assert.equal(recovered.body.appliedEntryRevision, 0);
  assert.equal((await f.call("owner", "save_trip_journal_entry", { ...command, note: "换了正文" })).status, 409);
  assert.equal((await f.call("owner", "delete_trip_journal", { entryId: command.entryId, expectedEntryRevision: 1, expectedRevision: 0, requestId: randomUUID() })).status, 200);
  assert.equal((await f.call("owner", "save_trip_journal_entry", command)).body.status, "deleted");
  assert.equal((await f.call("owner", "save_trip_journal_entry", { ...command, requestId: randomUUID() })).status, 409);
  assert.deepEqual((await f.call("owner", "list_trip_journal")).body.items, []);
  assert.deepEqual(await f.store.get(f.tripId), before, "private records must not enter the agent's trip state");
});

test("photo identity survives reordering and explicit relief save without changing source bytes", { skip: !database }, async t => {
  const f = await fixture(t), a = randomUUID(), b = randomUUID();
  const command = f.save({ photos: [{ photoId: a, data: jpeg }, { photoId: b, data: jpeg }] });
  assert.equal((await f.call("owner", "save_trip_journal_entry", command)).status, 200);
  const photo = () => f.call("owner", "read_trip_journal_image", { entryId: command.entryId, photoId: a });
  const original = (await photo()).body.data;
  const reorder = { ...command, requestId: randomUUID(), expectedEntryRevision: 0, photos: [{ photoId: b }, { photoId: a }] };
  const reordered = await f.call("owner", "save_trip_journal_entry", reorder); assert.equal(reordered.status, 200, JSON.stringify(reordered));
  assert.deepEqual(reordered.body.entry.photos.map(p => p.photoId), [b, a]);
  const effect = await f.call("owner", "save_trip_photo_relief", { entryId: command.entryId, photoId: a, expectedEntryRevision: 1, expectedRevision: 0, requestId: randomUUID(), relief: recipe });
  assert.equal(effect.status, 200); assert.deepEqual(effect.body.entry.photos[1].relief, recipe);
  assert.equal((await photo()).body.data, original);
  const reopened = await f.call("owner", "get_trip_journal_entry", { entryId: command.entryId });
  assert.deepEqual(reopened.body.entry.photos[1].relief, recipe);
  assert.equal(JSON.stringify(reopened).includes(original), false, "image bytes only belong in explicit authorized image reads");
});

test("shared viewer can read the same journal, editor can edit, and revocation denies media and old command recovery", { skip: !database }, async t => {
  const f = await fixture(t), command = f.save({ photos: [{ photoId: randomUUID(), data: jpeg }] });
  assert.equal((await f.call("owner", "save_trip_journal_entry", command)).status, 200);
  const grant = await f.grant("viewer"); assert.equal(grant.status, 200, JSON.stringify(grant));
  assert.equal((await f.call("viewer", "list_trip_journal")).body.items[0].entryId, command.entryId);
  assert.equal((await f.call("viewer", "save_trip_journal_entry", f.save())).status, 403);
  assert.equal((await f.call("viewer", "list_trip_share_members")).status, 403);
  assert.equal((await f.call("other", "get_trip_journal_entry", { entryId: command.entryId })).status, 403);
  assert.equal((await f.grant("editor")).status, 200);
  const editorCommand = { ...command, requestId: randomUUID(), expectedEntryRevision: 0, note: "同行人补记", photos: command.photos.map(p => ({ photoId: p.photoId })) };
  assert.equal((await f.call("viewer", "save_trip_journal_entry", editorCommand)).status, 200);
  const members = await f.call("owner", "list_trip_share_members");
  assert.equal((await f.call("owner", "revoke_trip_access", { accountId: f.people.viewer.userId, expectedAccessRevision: members.body.accessRevision, requestId: randomUUID() })).status, 200);
  assert.equal((await f.call("viewer", "read_trip_journal_image", { entryId: command.entryId, photoId: command.photos[0].photoId })).status, 403);
  assert.equal((await f.call("viewer", "save_trip_journal_entry", editorCommand)).status, 403);
  assert.equal(JSON.stringify(await f.store.get(f.tripId)).includes("example.test"), false);
});

test("sharing only resolves Google verified email digests and invalidates an outdated lookup", { skip: !database }, async t => {
  const f = await fixture(t);
  const found = await f.call("owner", "resolve_trip_share_email", { emailHash: digest("viewer@example.test") });
  assert.equal(found.status, 200); assert.equal(found.body.emailAuthoritative, false);
  await f.accounts.resolveIdentity({ provider: "google", subject: (await f.auth.query("SELECT subject FROM travel_google_profiles WHERE user_id=$1", [f.people.viewer.userId])).rows[0].subject, email: "changed@example.test", emailVerified: true });
  assert.equal((await f.call("owner", "grant_trip_share_email", { accountId: found.body.accountId, emailHash: digest("viewer@example.test"), role: "editor", expectedAccessRevision: 0, requestId: randomUUID() })).status, 404);
  const row = (await f.auth.query("SELECT * FROM travel_google_profiles WHERE user_id=$1", [f.people.viewer.userId])).rows[0];
  assert.equal(JSON.stringify(row).includes("changed@example.test"), false);
});

async function stageReview(t, f) {
  const root = await mkdtemp(join(tmpdir(), "workspace-review-")); t.after(() => rm(root, { recursive: true, force: true }));
  const localStore = new TripStore({ rootDir: join(root, "trips") });
  const localService = new TravelService({ store: localStore, researchProvider: planningProvider(), planningRunCoordinator: createTravelAnalysisRunCoordinator() });
  const faux = fauxProvider({ provider: "fixture-review", models: [{ id: "parent" }] }), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 20 }, () => context => planningResponse(context)));
  const agent = new TravelConversationAgent({ travelService: localService, conversationRepository: new FileConversationRepository({ rootDir: root }), modelRuntime: { models, model: faux.getModel("parent") } });
  const conversation = await agent.createConversation({ userId: f.people.owner.userId });
  const turn = await agent.reply({ conversationId: conversation.conversationId, userId: f.people.owner.userId, text: "上海一天预算6000，做完整行程。2026年10月15日出发" });
  assert.ok(turn.itineraryTrial?.previewId, JSON.stringify(turn));
  await f.store.create(await localStore.get(turn.tripId));
  for (const [id, cache] of localService.mobilityPreviewCache) await f.service.saveMobilityPreview(id, cache);
  f.service.researchProvider = planningProvider(); f.service.planningRunCoordinator = createTravelAnalysisRunCoordinator();
  return { tripId: turn.tripId, previewId: turn.itineraryTrial.previewId, proposalId: turn.itineraryTrial.proposalId };
}

test("per-account cloud review preserves unchanged conditions and adopts an explicitly tentative plan exactly once", { skip: !database }, async t => {
  const f = await fixture(t), target = await stageReview(t, f);
  const read = () => f.call("owner", "get_trip_review", target, target.tripId);
  let response = await read(); assert.equal(response.status, 200, JSON.stringify(response));
  let review = response.body; assert.deepEqual(review.blockers, []); assert.ok(review.conditions.length > 0); assert.equal(review.canAdopt, false);
  const first = review.conditions[0];
  const ack = condition => ({ ...target, expectedRevision: review.revision, expectedProgressVersion: review.progressVersion, conditionId: condition.conditionId, basisHash: condition.basisHash, acknowledged: true, requestId: randomUUID() });
  const initial = ack(first);
  response = await f.call("owner", "save_trip_review_condition", initial, target.tripId); assert.equal(response.status, 200, JSON.stringify(response)); review = response.body;
  response = await f.call("owner", "save_trip_review_condition", { ...ack(first), acknowledged: false }, target.tripId); review = response.body;
  response = await f.call("owner", "save_trip_review_condition", initial, target.tripId); assert.equal(response.body.conditions.find(c => c.conditionId === first.conditionId).acknowledged, false, "old retries cannot resurrect withdrawn acknowledgment"); review = response.body;
  for (const condition of review.conditions) { response = await f.call("owner", "save_trip_review_condition", ack(condition), target.tripId); assert.equal(response.status, 200, JSON.stringify(response)); review = response.body; }
  assert.equal((await read()).body.canAdopt, true, "reopening reads the cloud progress");
  const freshState = structuredClone(await f.store.get(target.tripId)), freshCache = structuredClone(await f.service.readMobilityPreview(target.previewId));
  const renewPriceTimestamp = value => { if (!value || typeof value !== "object") return; if (value.price?.checkedAt) value.price.checkedAt = new Date(Date.now() + 1000).toISOString(); Object.values(value).forEach(renewPriceTimestamp); };
  renewPriceTimestamp(freshState); freshCache.planningFingerprint = f.service.workspacePreviewFingerprint(freshState);
  const progress = { version: review.progressVersion, items: Object.fromEntries(review.conditions.map(c => [c.conditionId, { basisHash: c.basisHash, acknowledged: c.acknowledged }])) };
  const refreshed = buildDraftReview(freshState, freshCache, target, progress, new Date(), state => f.service.workspacePreviewFingerprint(state));
  assert.ok(refreshed.view.conditions.every(c => c.acknowledged), "a renewed check time with unchanged facts must not erase acknowledgments");
  const found = await f.call("owner", "resolve_trip_share_email", { emailHash: digest("viewer@example.test") }, target.tripId);
  assert.equal((await f.call("owner", "grant_trip_share_email", { ...target, emailHash: digest("viewer@example.test"), accountId: found.body.accountId, expectedAccessRevision: found.body.accessRevision, role: "editor", requestId: randomUUID() }, target.tripId)).status, 200);
  const other = await f.call("viewer", "get_trip_review", target, target.tripId); assert.equal(other.status, 200, JSON.stringify(other)); assert.equal(other.body.conditions.some(c => c.acknowledged), false);
  const before = await f.store.get(target.tripId), old = before.planning.draft;
  const stop = old.plan.days.flatMap(d => d.stops).find(s => s.role === "stay_check_in");
  const candidates = await f.service.getTripPlanView(target.tripId); const replacement = candidates.pendingProposals.flatMap(p => p.byDomain.stay ?? []).find(n => n.nodeId !== stop.nodeId);
  const change = await f.service.previewLocalChoice({ tripId: target.tripId, baseRevision: before.revision, basePlanId: old.planId, nodeId: replacement.nodeId, replaceNodeId: stop.nodeId });
  assert.ok(change.previewId, JSON.stringify(change)); Object.assign(target, { previewId: change.previewId, proposalId: change.proposalId });
  response = await read(); assert.equal(response.status, 200, JSON.stringify(response)); review = response.body;
  const unchangedIds = new Set(before.planning.draft.itinerary.stops.filter(s => s.nodeId !== stop.nodeId).map(s => s.stopId));
  const unchanged = review.conditions.filter(c => c.stopIds.length && c.stopIds.every(id => unchangedIds.has(id)));
  assert.ok(unchanged.length > 0); assert.ok(unchanged.every(c => c.acknowledged), JSON.stringify(unchanged));
  assert.ok(review.conditions.some(c => !c.acknowledged), "replacement must be acknowledged on its own basis");
  for (const condition of review.conditions.filter(c => !c.acknowledged)) { response = await f.call("owner", "save_trip_review_condition", ack(condition), target.tripId); assert.equal(response.status, 200, JSON.stringify(response)); review = response.body; }
  const command = { ...target, expectedRevision: review.revision, expectedProgressVersion: review.progressVersion, requestId: randomUUID() };
  response = await f.call("owner", "adopt_trip_reviewed_draft", command, target.tripId); assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body.adoptionStatus, "tentative");
  const saved = await f.store.get(target.tripId); assert.equal(saved.planning.adopted.adoptionStatus, "tentative"); assert.ok(saved.planning.adopted.unverifiedConditions.length > 0); assert.equal(saved.revision, before.revision + 1);
  assert.equal((await f.call("owner", "adopt_trip_reviewed_draft", command, target.tripId)).status, 200); assert.equal((await f.store.get(target.tripId)).revision, saved.revision);
  assert.equal((await f.service.undoTripChange({ tripId: target.tripId, changeId: saved.recentChange.changeId, baseRevision: saved.revision })).status, "committed");
});

test("acknowledging unknown facts never overrides a known over-budget conflict", { skip: !database }, async t => {
  const f = await fixture(t), target = await stageReview(t, f);
  const current = await f.store.get(target.tripId);
  current.brief.totalBudget = 1;
  await f.store.save(current, { expectedStorageVersion: current.storageVersion });
  const plan = structuredClone(current.planning.draft.plan); plan.runId = `review_budget_${randomUUID()}`; plan.attempt = 1;
  const trial = await f.service.planItineraryTrial({ tripId: target.tripId, plan, requireCompletePlan: true, userRequest: plan.objective });
  Object.assign(target, { previewId: trial.previewId, proposalId: trial.proposalId });
  let response = await f.call("owner", "get_trip_review", target, target.tripId); assert.equal(response.status, 200, JSON.stringify(response));
  let review = response.body; assert.ok(review.blockers.some(item => /budget|exceed/.test(item.code)), JSON.stringify(review.blockers));
  for (const condition of review.conditions) {
    response = await f.call("owner", "save_trip_review_condition", { ...target, requestId: randomUUID(), expectedRevision: review.revision, expectedProgressVersion: review.progressVersion, conditionId: condition.conditionId, basisHash: condition.basisHash, acknowledged: true }, target.tripId);
    assert.equal(response.status, 200, JSON.stringify(response)); review = response.body;
  }
  assert.equal(review.canAdopt, false);
  assert.equal((await f.call("owner", "adopt_trip_reviewed_draft", { ...target, requestId: randomUUID(), expectedRevision: review.revision, expectedProgressVersion: review.progressVersion }, target.tripId)).status, 409);
  assert.equal((await f.store.get(target.tripId)).planning.adopted, null);
});


test("legacy PostgreSQL records reopen through the same stable-photo service without a second write store", { skip: !database }, async t => {
  const f = await fixture(t), legacy = new TravelJournalRepository({ databaseUrl: f.databaseUrl }); t.after(() => legacy.close());
  const entryId = randomUUID();
  await legacy.create(f.tripId, { id: entryId, nodeId: "old-place", placeTitle: "原有照片", note: "已有记录", subject: "building", stage: "visited", createdAt: new Date().toISOString(), photos: [{ id: "0", data: jpeg, width: 1, height: 1, byteLength: Buffer.from(jpeg,"base64").length }] });
  const imported = await f.call("owner", "list_trip_journal"); assert.equal(imported.status, 200); const entry = imported.body.items[0]; assert.equal(entry.entryId, entryId);
  const bytes = await f.call("owner", "read_trip_journal_image", { entryId, photoId: entry.photos[0].photoId }); assert.equal(bytes.body.data, jpeg);
  const options = { headers: { Authorization: `Bearer ${f.people.owner.token}` } };
  const oldList = await fetch(`${f.base}/api/trips/${f.tripId}/journal`, options); assert.equal((await oldList.json()).entries[0].photos[0].id, entry.photos[0].photoId);
  const oldIndex = await fetch(`${f.base}/api/trips/${f.tripId}/journal/${entryId}/photos/0`, options); assert.equal(oldIndex.status, 410);
  const oldDelete = await fetch(`${f.base}/api/trips/${f.tripId}/journal/${entryId}`, { ...options, method: "DELETE" }); assert.equal(oldDelete.status, 409);
  assert.equal((await f.call("owner", "list_trip_journal")).body.items.length, 1);
});

test("downgrading an editor fences a previously prepared ordinary HTTP write at the database", { skip: !database }, async t => {
  const f = await fixture(t); assert.equal((await f.grant("editor")).status, 200);
  const stale = await f.store.get(f.tripId); stale.brief.destination = "迟到的修改";
  assert.equal((await f.grant("viewer")).status, 200);
  await assert.rejects(withTravelActor(f.people.viewer.userId, () => f.store.save(stale, { expectedStorageVersion: stale.storageVersion })), { code: "trip_access_denied" });
  assert.equal((await f.store.get(f.tripId)).brief.destination, "受控旅行");
});

test("MCP read-only OAuth permits authorized workspace reads over POST while refusing writes", { skip: !database }, async t => {
  const f = await fixture(t), oauth = f.oauth, redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const client = await oauth.registerClient({ client_name: "Read only workspace", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  const verifier = "travel_test_verifier_abcdefghijklmnopqrstuvwxyz_123456789"; let destination;
  await oauth.authorize(client, { scopes: ["travel:read"], redirectUri: redirect, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), resource: new URL(oauth.resource) }, { redirect: value => { destination = value; } });
  const callback = await oauth.approve(new URL(destination).searchParams.get("request"), { userId: f.people.owner.userId, provider: "google", displayName: "Owner" });
  const grant = await oauth.exchangeAuthorizationCode(client, new URL(callback).searchParams.get("code"), verifier, redirect, new URL(oauth.resource));
  const action = (name, args = {}) => fetch(`${f.base}/api/trips/${f.tripId}/workspace/${name}`, { method: "POST", headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  assert.equal((await action("get_trip_workspace_access")).status, 200);
  assert.equal((await action("list_trip_journal")).status, 200);
  assert.equal((await action("save_trip_journal_entry", f.save())).status, 401);
});


test("revocation pauses trip watches and prevents an in-flight quote from creating another notification", { skip: !database }, async t => {
  const f = await fixture(t); assert.equal((await f.grant("editor")).status, 200);
  const repository = new ContinuityRepository({ databaseUrl: f.databaseUrl }); t.after(() => repository.close());
  let started, release; const entered = new Promise(r => { started = r; }), held = new Promise(r => { release = r; });
  const conditions = { kind: "hotel", provider: "fixture", providerRef: "room", dates: ["2026-12-01", "2026-12-02"], adults: 1, childrenAges: [], rooms: 1, product: "双床", meal: "含早餐", refund: "可退", baggage: "not_applicable", tax: "included", currency: "CNY", priceUnit: "per_booking" };
  const continuity = new TravelContinuityService(repository, { async check() { started(); await held; return { conditions, amount: 50, checkedAt: Date.now() }; } });
  const userId = f.people.viewer.userId;
  const watch = await continuity.createWatch(userId, { tripId: f.tripId, nodeId: "fixture_room", title: "受控关注", conditions, targetAmount: 100, expiresAt: Date.now() + 86400000, email: false });
  await repository.query("INSERT INTO travel_notifications(notification_id,user_id,watch_id,event_key,content_json,created_at) VALUES($1,$2,$3,$4,'{}',$5)", [randomUUID(), userId, watch.watchId, "existing_event", Date.now()]);
  await repository.query("INSERT INTO travel_email_outbox(event_key,user_id,payload_json,created_at) VALUES('existing_event',$1,'{}',$2)", [userId, Date.now()]);
  const running = continuity.checkDue("controlled_watch_worker", new AbortController().signal); await entered;
  const members = await f.call("owner", "list_trip_share_members");
  const revoked = await f.call("owner", "revoke_trip_access", { accountId: userId, expectedAccessRevision: members.body.accessRevision, requestId: randomUUID() });
  release(); await running; assert.equal(revoked.status, 200, JSON.stringify(revoked));
  const current = (await continuity.watches(userId))[0]; assert.equal(current.status, "paused"); assert.equal(current.lastError, "trip_access_revoked"); assert.equal(current.lastQuote, null);
  assert.equal((await continuity.notifications(userId)).length, 1, "a late quote must not create another notification");
  assert.equal((await repository.query("SELECT status FROM travel_email_outbox WHERE event_key='existing_event'")).rows[0].status, "cancelled");
});
