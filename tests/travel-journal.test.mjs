import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildJournalEntry, registerTravelJournalRoutes, sanitizeJournalJpeg } from "../src/http/travel-journal.mjs";
import { TravelJournalRepository } from "../src/persistence/travel-journal-repository.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { InMemorySessionStore } from "../src/http/session.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { defaultPhotoRelief } from "../src/media/photo-relief-recipe.mjs";

// Tiny baseline JPEG fixture. Test pixels are not product/demo place data.
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAA//2Q==";
const clock = () => new Date("2026-09-14T10:00:00Z");
const node = { nodeId: "play_journal", domain: "play", title: "旅行中的建筑", selected: false, sourceStatus: "user_input", sourceRefs: [], claimRefs: [] };
const body = (changes = {}) => ({ id: randomUUID(), nodeId: node.nodeId, subject: "building", stage: "visited", note: "傍晚的光线", takenOn: "2026-09-13", photos: [{ data: jpeg }], ...changes });
const entry = (changes = {}) => buildJournalEntry(body(changes), { node, clock });

test("four cold API instances can initialize a private journal concurrently", { skip: !process.env.TRAVEL_JOURNAL_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.TRAVEL_JOURNAL_TEST_DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `journal_cold_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const repositories = Array.from({ length: 4 }, () => new TravelJournalRepository({ databaseUrl: url.toString() }));
  try {
    const results = await Promise.allSettled(repositories.map((repository, index) => repository.create(`cold_${index}`, entry())));
    assert.deepEqual(results.map(result => result.status === "fulfilled" ? "saved" : result.reason.code), Array(4).fill("saved"));
    for (let index = 0; index < 4; index++) assert.equal((await repositories[(index + 1) % 4].list(`cold_${index}`)).length, 1);
  } finally {
    await Promise.all(repositories.map(repository => repository.close()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

test("landscape records persist local photo-relief recipes; food cannot enable modelling", () => {
  const relief = defaultPhotoRelief();
  const record = entry({ subject: "landscape", photos: [{ data: jpeg, relief }] });
  assert.deepEqual(record.photos[0].relief, relief);
  assert.deepEqual(record.model, { status: "recipe_saved", kind: "photo-relief-v1", reconstruction: false, processing: "on_device" });
  assert.throws(() => entry({ subject: "food", photos: [{ data: jpeg, relief }] }), { code: "journal_relief_subject_unsupported" });
  assert.throws(() => entry({ photos: [{ data: jpeg, relief: { ...relief, url: "https://untrusted.invalid/model.glb" } }] }), { code: "journal_relief_invalid" });
});

test("journal JPEG boundary removes metadata and trailing bytes; rejects unsafe formats and dimensions", () => {
  const clean = sanitizeJournalJpeg(jpeg);
  assert.equal(clean.width, 1); assert.equal(clean.height, 1);
  const original = Buffer.from(jpeg, "base64");
  const metadata = Buffer.from("Exif\0\0GPS secret original-filename.jpg");
  const segment = Buffer.alloc(metadata.length + 4); segment.writeUInt16BE(0xffe1, 0); segment.writeUInt16BE(metadata.length + 2, 2); metadata.copy(segment, 4);
  const withMetadata = Buffer.concat([original.subarray(0, 2), segment, original.subarray(2), Buffer.from("trailing-sensitive-data")]);
  assert.equal(sanitizeJournalJpeg(withMetadata.toString("base64")).data, clean.data);
  for (const payload of ["<svg onload=alert(1)>", "A".repeat(600_001), original.subarray(0, -3).toString("base64"), "iVBORw0KGgo="]) assert.throws(() => sanitizeJournalJpeg(payload), { code: "journal_photo_invalid" });
  const oversized = Buffer.from(original); const sof = oversized.indexOf(Buffer.from([0xff, 0xc0])); oversized.writeUInt16BE(20000, sof + 7);
  assert.throws(() => sanitizeJournalJpeg(oversized.toString("base64")), { code: "journal_photo_invalid" });
  const progressive = Buffer.from(original); progressive[sof + 1] = 0xc2;
  assert.throws(() => sanitizeJournalJpeg(progressive.toString("base64")), { code: "journal_photo_invalid" });
  for (const changes of [{ takenOn: "2026-02-30" }, { stage: "published" }, { note: "x".repeat(1001) }, { photos: [] }, { photos: Array(4).fill({ data: jpeg }) }]) assert.throws(() => entry(changes));
  const record = entry({ visibility: "anonymous_travelers", model: { status: "ready", url: "https://untrusted.invalid" }, filename: "secret.jpg" });
  assert.equal(record.visibility, "trip_only"); assert.deepEqual(record.model, { status: "not_generated" }); assert.equal(record.filename, undefined);
});

for (const backend of ["file", "postgres"]) {
  test(`${backend}: journal persists, retries idempotently, isolates trips, and deletes`, { skip: backend === "postgres" && !process.env.TRAVEL_JOURNAL_TEST_DATABASE_URL }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "travel-journal-"));
    const options = backend === "postgres" ? { databaseUrl: process.env.TRAVEL_JOURNAL_TEST_DATABASE_URL } : { rootDir };
    const repository = new TravelJournalRepository(options), second = new TravelJournalRepository(options);
    const tripId = `journal_${randomUUID()}`, record = entry();
    try {
      const saved = await Promise.all(Array.from({ length: 5 }, () => repository.create(tripId, record)));
      assert.equal(saved.length, 5); assert.equal((await second.list(tripId)).length, 1);
      assert.equal(JSON.stringify(saved).includes(record.photos[0].data), false);
      assert.equal(saved[0].contentHash, undefined);
      assert.equal((await second.get(tripId, record.id)).photos[0].data, record.photos[0].data);
      assert.equal(await second.get("another_trip", record.id), null);
      assert.deepEqual(await second.list(tripId, "another_node"), []);
      await assert.rejects(repository.create(tripId, entry({ id: record.id, note: "changed" })), { code: "journal_id_conflict" });
      if (backend === "file") {
        assert.equal((await stat(repository.filename(tripId))).mode & 0o077, 0);
        assert.equal((await stat(rootDir)).mode & 0o077, 0);
      }
      await second.delete(tripId, record.id); await second.delete(tripId, record.id);
      assert.deepEqual(await repository.list(tripId), []);
    } finally { await repository.delete(tripId, record.id); await repository.close(); await second.close(); await rm(rootDir, { recursive: true, force: true }); }
  });
}

test("journal route handler preserves a pending candidate memory after rejection (no HTTP transport)", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-journal-handler-"));
  const tripId = "trip_journal_handler";
  const store = new TripStore({ rootDir: join(rootDir, "trips") });
  const service = new TravelService({ store, clock });
  const repository = new TravelJournalRepository({ rootDir: join(rootDir, "photos") });
  const routes = new Map();
  const app = Object.fromEntries(["get", "post", "delete"].map((method) => [method, (path, handler) => routes.set(`${method}:${path}`, handler)]));
  // Invoke the production route body with real service/repository objects; this
  // deliberately does not claim network, browser, or session-cookie coverage.
  registerTravelJournalRoutes({ app, asyncRoute: (handler) => handler, requireTripMember: async () => ({ userId: "journal_owner" }), travelService: service, repository, clock });
  const call = async (method, suffix = "", input = undefined, query = {}) => {
    let result;
    const response = { status() { return this; }, json(value) { result = value; return this; }, end() { return this; } };
    await routes.get(`${method}:/api/trips/:tripId/journal${suffix}`)({ params: { tripId, entryId: input?.id }, body: input, query }, response);
    return result;
  };
  try {
    await service.createTrip({ tripId, brief: { destination: "上海" }, travelers: [{ travelerId: "traveler_1" }], ownerUserId: "journal_owner" });
    const proposal = { schemaVersion: "trip-patch-proposal-v1", proposalId: "journal_pending", tripId, baseRevision: 0, writeSet: [node.nodeId], writeContract: { allowedNodeIds: [node.nodeId] }, readSet: [], operations: [{ kind: "add_candidate", nodeId: node.nodeId, node }], evidence: { sources: [], entities: [], claims: [] } };
    assert.equal((await service.proposeTripChange({ tripId, proposal })).status, "proposed");
    const before = await readFile(store.pathFor(tripId), "utf8");
    const input = body({ stage: "wish" });
    const saved = await call("post", "", input);
    assert.equal(saved.nodeId, node.nodeId); assert.equal(saved.stage, "wish");
    assert.equal(saved.photos[0].data, undefined);
    assert.equal(await readFile(store.pathFor(tripId), "utf8"), before);
    await assert.rejects(call("post", "", {}), { code: "journal_input_invalid" });
    assert.equal((await service.rejectTripChange({ tripId, proposalId: proposal.proposalId })).status, "rejected_by_user");
    const afterRejection = await readFile(store.pathFor(tripId), "utf8");
    assert.deepEqual((await service.getTripPlanView(tripId)).pendingProposals, []);
    assert.equal((await call("get")).entries[0].placeTitle, node.title);
    assert.equal((await call("post", "", input)).id, saved.id);
    await assert.rejects(call("post", "", { ...input, note: "changed" }), { code: "journal_id_conflict" });
    await assert.rejects(call("post", "", { ...input, id: randomUUID() }), { code: "journal_node_not_found" });
    await call("delete", "/:entryId", input);
    assert.deepEqual((await call("get")).entries, []);
    assert.equal(await readFile(store.pathFor(tripId), "utf8"), afterRejection);
  } finally { await repository.close(); await rm(rootDir, { recursive: true, force: true }); }
});

for (const lifecycle of ["pending", "accepted"]) {
test(`real HTTP journal: ${lifecycle} place supports private memories without accepting travel decisions`, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-journal-http-"));
  const store = new TripStore({ rootDir: join(rootDir, "trips") });
  const service = new TravelService({ store, clock });
  const sessions = new InMemorySessionStore({ clock });
  const owner = await sessions.issue({ userId: "journal_owner", provider: "google" });
  const outsider = await sessions.issue({ userId: "journal_outsider", provider: "google" });
  const repository = new TravelJournalRepository({ rootDir: join(rootDir, "photos") });
  await service.createTrip({ tripId: "trip_journal_http", brief: { destination: "上海" }, travelers: [{ travelerId: "traveler_1" }], ownerUserId: "journal_owner" });
  await service.createTrip({ tripId: "trip_journal_legacy", brief: { destination: "上海" }, travelers: [{ travelerId: "traveler_1" }] });
  const proposal = { schemaVersion: "trip-patch-proposal-v1", proposalId: "journal_candidate", tripId: "trip_journal_http", baseRevision: 0, writeSet: [node.nodeId], writeContract: { allowedNodeIds: [node.nodeId] }, readSet: [], operations: [{ kind: "add_candidate", nodeId: node.nodeId, node }], evidence: { sources: [], entities: [], claims: [] } };
  const staged = await service.proposeTripChange({ tripId: "trip_journal_http", proposal });
  assert.equal(staged.status, "proposed");
  if (lifecycle === "accepted") assert.equal((await service.acceptTripChange({ tripId: "trip_journal_http", proposalId: proposal.proposalId })).status, "committed");
  let before = await readFile(store.pathFor("trip_journal_http"), "utf8");
  const app = createHttpApp({ travelService: service, sessionStore: sessions, journalRepository: repository, conversationRepository: new FileConversationRepository({ rootDir: join(rootDir, "conversations") }), conversationAgent: new Proxy({}, { get: () => () => { throw new Error("Journal must not invoke AI"); } }), runtimeEnv: { NODE_ENV: "test", TRAVEL_AGENT_DATA_DIR: rootDir }, clock });
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/trips/trip_journal_http/journal`;
  const request = (suffix = "", { method = "GET", token = owner.opaqueToken, data } = {}) => fetch(`${base}${suffix}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json" } : {}) }, body: data ? JSON.stringify(data) : undefined });
  try {
    assert.equal((await request("", { token: null })).status, 401);
    assert.equal((await request("", { token: outsider.opaqueToken })).status, 403);
    assert.equal((await fetch(base.replace("trip_journal_http", "trip_journal_legacy"), { headers: { Authorization: `Bearer ${owner.opaqueToken}` } })).status, 403);
    assert.equal((await request("", { method: "POST", data: body({ nodeId: "missing" }) })).status, 404);
    const input = body({ subject: "landscape", photos: [{ data: jpeg, relief: defaultPhotoRelief() }] });
    const saved = await request("", { method: "POST", data: input }); assert.equal(saved.status, 201);
    const record = await saved.json(); assert.equal(record.photos[0].data, undefined);
    assert.equal(record.model.status, "recipe_saved"); assert.deepEqual(record.photos[0].relief, defaultPhotoRelief());
    const retried = await request("", { method: "POST", data: input }); assert.equal(retried.status, 201);
    assert.equal((await (await request()).json()).entries.length, 1);
    assert.equal(await readFile(store.pathFor("trip_journal_http"), "utf8"), before);
    if (lifecycle === "pending") {
      assert.equal((await service.rejectTripChange({ tripId: "trip_journal_http", proposalId: proposal.proposalId })).status, "rejected_by_user");
      before = await readFile(store.pathFor("trip_journal_http"), "utf8");
      assert.deepEqual((await service.getTripPlanView("trip_journal_http")).pendingProposals, []);
      const memories = (await (await request()).json()).entries;
      assert.equal(memories.length, 1); assert.equal(memories[0].placeTitle, node.title);
      assert.equal((await request("", { method: "POST", data: input })).status, 201, "Retry survives candidate removal");
      assert.equal((await request("", { method: "POST", data: { ...input, note: "changed" } })).status, 409, "Retry cannot overwrite a saved memory");
      assert.equal((await request("", { method: "POST", data: { ...input, id: randomUUID() } })).status, 404, "Removed candidates cannot authorize new records");
    }
    const photoPath = `/${record.id}/photos/0`;
    assert.equal((await request(photoPath, { token: outsider.opaqueToken })).status, 403);
    const photo = await request(photoPath); assert.equal(photo.status, 200); assert.equal(photo.headers.get("content-type"), "image/jpeg"); assert.match(photo.headers.get("cache-control"), /no-store/);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(sanitizeJournalJpeg(jpeg).data, "base64"));
    assert.equal((await request(`/${record.id}`, { method: "DELETE", token: outsider.opaqueToken })).status, 403);
    assert.equal((await request(`/${record.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await request(photoPath)).status, 404);
    assert.equal(await readFile(store.pathFor("trip_journal_http"), "utf8"), before);
  } finally { await new Promise((resolve) => server.close(resolve)); await app.locals.close(); await repository.close(); await rm(rootDir, { recursive: true, force: true }); }
});
}
