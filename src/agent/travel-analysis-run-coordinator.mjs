export function createTravelAnalysisRunCoordinator() {
  const runs = new Map();
  const activeByTrip = new Map();

  function begin({ runId, tripId, baseRevision, criteriaFingerprint, requiredLanes, deadlineAt, scopeFingerprint = null }) {
    const existing = runs.get(runId);
    if (existing) {
      if (existing.tripId !== tripId || existing.baseRevision !== baseRevision || existing.criteriaFingerprint !== criteriaFingerprint) {
        throw Object.assign(new Error("analysis_run_identity_conflict"), { code: "analysis_run_identity_conflict", runId });
      }
      return existing;
    }
    const previousId = activeByTrip.get(tripId);
    const previous = previousId ? runs.get(previousId) : null;
    if (previous && !["joined", "stale_discarded", "superseded", "failed"].includes(previous.status)) {
      previous.status = "superseded";
      previous.supersededBy = runId;
      previous.abortController.abort("superseded_by_newer_run");
    }
    const run = {
      runId,
      tripId,
      baseRevision,
      criteriaFingerprint,
      scopeFingerprint,
      requiredLanes: [...new Set(requiredLanes)],
      deadlineAt,
      status: "analyzing",
      abortController: new AbortController(),
      lanes: new Map(),
      joinArtifact: null,
      supersededBy: null,
    };
    runs.set(runId, run);
    activeByTrip.set(tripId, runId);
    return run;
  }

  function isCurrent({ runId, tripId, baseRevision, criteriaFingerprint }) {
    const run = runs.get(runId);
    return Boolean(run
      && activeByTrip.get(tripId) === runId
      && run.status === "analyzing"
      && run.baseRevision === baseRevision
      && run.criteriaFingerprint === criteriaFingerprint);
  }

  function laneKey(lane, attempt) {
    return `${lane}:${attempt}`;
  }

  function recordLaneStarted(runId, { lane, attempt, queuedAt, startedAt }) {
    const run = runs.get(runId);
    if (!run || run.status !== "analyzing") return null;
    const key = laneKey(lane, attempt);
    const existing = run.lanes.get(key);
    if (existing) return existing;
    const record = { lane, attempt, queuedAt, startedAt, completedAt: null, status: "running", result: null };
    run.lanes.set(key, record);
    return record;
  }

  function recordLaneCompletion(runId, { lane, attempt, completedAt, status, result }) {
    const run = runs.get(runId);
    if (!run) return null;
    const key = laneKey(lane, attempt);
    const existing = run.lanes.get(key);
    if (existing?.completedAt) return existing;
    const record = existing ?? { lane, attempt, queuedAt: completedAt, startedAt: completedAt };
    Object.assign(record, { completedAt, status, result });
    run.lanes.set(key, record);
    return record;
  }

  function tryJoin(runId) {
    const run = runs.get(runId);
    if (!run) return { acquired: false, reason: "run_not_found", artifact: null };
    if (run.status === "joined") return { acquired: false, reason: "already_joined", artifact: run.joinArtifact };
    if (run.status !== "analyzing") return { acquired: false, reason: run.status, artifact: run.joinArtifact };
    run.status = "joining";
    return { acquired: true, reason: "compare_and_set", artifact: null };
  }

  function completeJoin(runId, artifact) {
    const run = runs.get(runId);
    if (!run || run.status !== "joining") return run?.joinArtifact ?? null;
    run.status = "joined";
    run.joinArtifact = artifact;
    return artifact;
  }

  function markStale(runId, reason = "stale_discarded") {
    const run = runs.get(runId);
    if (!run) return null;
    if (run.status !== "joined") run.status = "stale_discarded";
    run.staleReason = reason;
    run.abortController.abort(reason);
    return run;
  }

  function supersedeTrip(tripId, reason = "trip_scope_changed") {
    const runId = activeByTrip.get(tripId);
    const run = runId ? runs.get(runId) : null;
    if (!run || ["joined", "stale_discarded", "superseded", "failed"].includes(run.status)) return null;
    run.status = "superseded";
    run.staleReason = reason;
    run.abortController.abort(reason);
    return run;
  }

  function get(runId) {
    return runs.get(runId) ?? null;
  }

  function resumeRepair(runId, { criteriaFingerprint }) {
    const run = runs.get(runId);
    if (!run || activeByTrip.get(run.tripId) !== runId || run.lanes.has("itinerary_plan:2")
      || !run.lanes.get("itinerary_plan:1")?.completedAt || Date.now() >= Date.parse(run.deadlineAt)
      || (run.status !== "analyzing" && !(run.status === "superseded" && run.staleReason === "candidate_set_changed"))) return false;
    run.criteriaFingerprint = criteriaFingerprint;
    run.status = "analyzing";
    run.abortController = new AbortController();
    return true;
  }

  return { begin, isCurrent, recordLaneStarted, recordLaneCompletion, tryJoin, completeJoin, markStale, supersedeTrip, get, resumeRepair };
}
