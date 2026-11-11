// Launched only by the isolated Java integration test; the model is a local faux provider.
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createWorkerClient } from "../src/client.mjs";
import { createPiRunner } from "../src/pi-runner.mjs";
import { executeTask } from "../src/worker.mjs";

const client = createWorkerClient({ baseUrl: process.env.TRAVEL_TEST_SERVICE_URL, token: process.env.TRAVEL_TEST_WORKER_TOKEN });
const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("read_trip_context", {}, { id: "trip-read" })]),
  fauxAssistantMessage([fauxToolCall("search_trip_places", { domain: "play", keyword: "博物馆", page: 1, pageSize: 10 }, { id: "place-read" })]),
  fauxAssistantMessage([fauxToolCall("check_trip_flight_status", { carrier: "MU", flight: "5101", departureAirportIata: "SHA", departureDateLocal: "2026-11-07" }, { id: "flight-read" })]),
  fauxAssistantMessage([fauxToolCall("check_trip_walking_route", { origin: { resultId: process.env.TRAVEL_TEST_PLACE_RESULT, sourceId: "fixture-from" },
    destination: { resultId: process.env.TRAVEL_TEST_PLACE_RESULT, sourceId: "fixture-to" } }, { id: "walking-read" })]),
  fauxAssistantMessage(JSON.stringify({ kind: "needs_context", summary: "地点资料已读取，营业条件仍需核验。", evidenceIds: [], unknowns: ["营业和库存"] })),
]);
const run = await createPiRunner({ provider: faux.provider, modelId: faux.getModel().id });
const task = await client.post("claim");
if (task.status !== "running") throw new Error("no_test_task_claimed");
await executeTask(task, client, run, new AbortController().signal);
