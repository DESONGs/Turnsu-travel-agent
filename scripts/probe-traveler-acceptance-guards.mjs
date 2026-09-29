// Negative adoption probes against this task's isolated, fictional trips only.
// Calls the same public TravelService used by authenticated adoption routes.
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { planningProvider } from "../tests/fixtures/jev-planning.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
const url = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/travel_execution_test") throw new Error("isolated_test_database_required");
const directory = process.env.TRAVEL_USER_TEST_OUTPUT;
const data = JSON.parse(await readFile(`${directory}/results.json`, "utf8"));
const output = { startedAt: new Date().toISOString(), expected: "Unknown mandatory accessibility and over-budget plans must fail adoption, independently of model wording.", scope: "Public TravelService adoption, isolated PostgreSQL and already generated fictional test trips; no external booking or purchase.", rows: [] };
await writeFile(`${directory}/adoption-guards.json`, JSON.stringify(output, null, 2)+"\n");
const admin = new Pool({ connectionString: url.toString(), max: 1 });
try {
  const schemas = (await admin.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'traveler_%' AND nspname NOT LIKE '%_real'")).rows.map(row=>row.nspname);
  for (const id of ["T06", "T07"]) {
    const turn = data.rows.find(row=>row.id===id)?.turns[0];
    if (!turn?.runId) continue;
    for (const schema of schemas) {
      if (!/^traveler_[a-f0-9]+$/.test(schema)) continue;
      const run = (await admin.query(`SELECT trip_id FROM ${schema}.travel_runs WHERE run_id=$1`, [turn.runId])).rows[0];
      if (!run) continue;
      const scoped = new URL(url); scoped.searchParams.set("options", `-c search_path=${schema}`);
      const pool = new Pool({ connectionString: scoped.toString(), max: 2 });
      try {
        const store = new PostgresTripRepository({ pool });
        const service = new TravelService({ store, researchProvider: planningProvider() });
        const before = await store.get(run.trip_id);
        const proposal = before.pendingProposals.find(p => p.operations.some(op => op.kind === "add_candidate"));
        if (!proposal) { output.rows.push({ id, status: "not_verified_no_candidates" }); continue; }
        const selections = {};
        for (const op of proposal.operations) if (op.kind === "add_candidate" && !selections[op.node.domain]) selections[op.node.domain] = op.nodeId;
        const preview = await service.previewTripMobility({ tripId: run.trip_id, selections, baseRevision: before.revision });
        const row = { id, tripBudget: before.brief.totalBudget, travelers: before.travelers, selectedBefore: before.nodes.filter(n=>n.selected).length, feasibilityBefore: preview.feasibility };
        try { row.adoption = await service.acceptTripChange({ tripId: run.trip_id, proposalId: proposal.proposalId, selections, partial: true, previewId: preview.previewId, baseRevision: before.revision }); }
        catch (error) { row.error = { code: error.code ?? error.message }; }
        const after = await store.get(run.trip_id);
        row.selectedAfter = after.nodes.filter(n=>n.selected).length;
        row.stateUnchanged = JSON.stringify(before) === JSON.stringify(after);
        row.status = row.adoption?.status === "rejected" && row.adoption?.feasibility?.canConfirm === false && row.stateUnchanged ? "blocked_by_business_guard" : "failed_guard_committed_or_not_verified";
        row.qaAfter = (await service.getTripPlanView(run.trip_id)).qa;
        output.rows.push(row);
      } finally { await pool.end(); }
      break;
    }
  }
} finally { await admin.end(); }
await writeFile(`${directory}/adoption-guards.json`,JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify(output.rows.map(r=>({id:r.id,status:r.status,selectedBefore:r.selectedBefore,selectedAfter:r.selectedAfter,error:r.error,adoptionStatus:r.adoption?.status}))));
if (output.rows.some(row => row.status.startsWith("failed_guard"))) process.exitCode = 1;
else if (output.rows.length !== 2 || output.rows.some(row => row.status !== "blocked_by_business_guard")) process.exitCode = 2;
