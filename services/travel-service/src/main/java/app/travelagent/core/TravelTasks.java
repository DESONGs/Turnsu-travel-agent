package app.travelagent.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import app.travelagent.auth.WorkerSettings;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** Durable planning handoff. Worker results are suggestions, never trip commits. */
@Service
public class TravelTasks {
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JsonMapper json = JsonMapper.builder().build();
    private final boolean enabled;
    private final int maxRunning;
    private final int maxRunningPerAccount;
    private final int maxQueued;
    private final TravelItineraryDrafts drafts;

    @Autowired
    public TravelTasks(JdbcTemplate jdbc, TransactionTemplate transactions, WorkerSettings worker, TravelItineraryDrafts drafts) {
        this(jdbc, transactions, worker.configured(), 32, 2, 1000, drafts);
    }
    public TravelTasks(JdbcTemplate jdbc, TransactionTemplate transactions, boolean enabled, int maxRunning, int maxRunningPerAccount, int maxQueued, TravelItineraryDrafts drafts) {
        this.jdbc = jdbc; this.transactions = transactions; this.enabled = enabled; this.drafts = java.util.Objects.requireNonNull(drafts);
        if (maxRunning < 1 || maxRunningPerAccount < 1 || maxQueued < 1) throw new IllegalArgumentException("invalid_task_limits");
        this.maxRunning = maxRunning; this.maxRunningPerAccount = maxRunningPerAccount; this.maxQueued = maxQueued;
    }

    public Map<String, Object> submit(UUID actor, UUID trip, long expectedRevision, String requestId, String objective) {
        if (!enabled) throw new TravelError("background_executor_not_configured");
        if (actor == null || trip == null || expectedRevision < 0 || objective == null || objective.isBlank() || objective.length() > 4000)
            throw new TravelError("invalid_task_input");
        TripStateFactory.safeObject(Map.of("objective", objective));
        var input = Map.<String, Object>of("tripId", trip.toString(), "expectedRevision", expectedRevision, "objective", objective);
        return receipt(actor, requestId, "submit_planning_task", input, () -> accessLocked(actor, trip, true), () -> {
            var current = accessLocked(actor, trip, true);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            advisory("travel-planning-queue-admission");
            int queued = jdbc.queryForObject("SELECT count(*) FROM travel_planning_tasks WHERE status='queued'", Integer.class);
            if (queued >= maxQueued) throw new TravelError("planning_queue_full");
            UUID task = UUID.randomUUID();
            jdbc.update("""
                    INSERT INTO travel_planning_tasks(task_id,trip_id,created_by,request_id,input_hash,objective,base_revision,status)
                    VALUES (?,?,?,?,?,?,?,'queued')
                    """, task, trip, actor, requestId, hash(json.writeValueAsString(canonical(input))), objective, expectedRevision);
            return taskView(task);
        });
    }

    public Map<String, Object> get(UUID actor, UUID task) {
        if (actor == null || task == null) throw new TravelError("task_not_found");
        var rows = jdbc.query("""
                SELECT q.task_id,q.trip_id,q.objective,q.base_revision,q.generation,q.status,q.checkpoint::text,q.suggestion::text,
                       q.created_at,q.updated_at,(q.status='running' AND q.lease_until<=CURRENT_TIMESTAMP),q.failure_code,
                       (q.base_revision<>(SELECT revision FROM travel_trips WHERE trip_id=q.trip_id))
                FROM travel_planning_tasks q JOIN travel_trip_access a ON a.trip_id=q.trip_id
                WHERE q.task_id=? AND a.account_id=?
                """, (rs, n) -> taskView(rs), task, actor);
        if (rows.isEmpty()) throw new TravelError("task_not_found");
        return rows.get(0);
    }

    public Map<String, Object> list(UUID actor, UUID trip, int limit, Instant beforeTime, UUID beforeId) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        if (limit < 1 || limit > 50 || (beforeTime == null) != (beforeId == null)) throw new TravelError("invalid_page");
        var access = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, actor);
        if (access.isEmpty()) throw new TravelError("trip_not_found");
        String sql = """
                SELECT task_id,trip_id,objective,base_revision,generation,status,checkpoint::text,suggestion::text,
                       created_at,updated_at,(status='running' AND lease_until<=CURRENT_TIMESTAMP),failure_code,
                       (base_revision<>(SELECT revision FROM travel_trips WHERE trip_id=travel_planning_tasks.trip_id))
                FROM travel_planning_tasks WHERE trip_id=? AND EXISTS
                    (SELECT 1 FROM travel_trip_access a WHERE a.trip_id=travel_planning_tasks.trip_id AND a.account_id=?)
                """ + (beforeTime == null ? "" : " AND (created_at,task_id) < (?,?) ") + " ORDER BY created_at DESC,task_id DESC LIMIT ?";
        var mapper = (org.springframework.jdbc.core.RowMapper<Map<String, Object>>) (rs, n) -> taskView(rs);
        var rows = beforeTime == null ? jdbc.query(sql, mapper, trip, actor, limit + 1)
                : jdbc.query(sql, mapper, trip, actor, java.sql.Timestamp.from(beforeTime), beforeId, limit + 1);
        var items = rows.size() > limit ? rows.subList(0, limit) : rows;
        Object cursor = rows.size() > limit ? Map.of("createdAt", items.get(items.size() - 1).get("createdAt"), "taskId", items.get(items.size() - 1).get("taskId")) : null;
        var result = new LinkedHashMap<String, Object>(); result.put("items", items); result.put("nextCursor", cursor); return result;
    }

    public Map<String, Object> takeOver(UUID actor, UUID task, long expectedRevision, String requestId) {
        return change(actor, task, expectedRevision, requestId, "take_over_planning_task", row -> {
            if (!("queued".equals(row.status()) || "running".equals(row.status()))) throw new TravelError("task_not_active");
            jdbc.update("""
                    UPDATE travel_planning_tasks SET status='paused',generation=generation+1,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
                    WHERE task_id=?
                    """, task);
        });
    }

    public Map<String, Object> handBack(UUID actor, UUID task, long expectedRevision, String requestId) {
        return change(actor, task, expectedRevision, requestId, "hand_back_planning_task", row -> {
            if (!"paused".equals(row.status())) throw new TravelError("task_not_paused");
            String next = row.baseRevision() == expectedRevision ? "queued" : "superseded";
            jdbc.update("UPDATE travel_planning_tasks SET status=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=?", next, task);
        });
    }

    public Map<String, Object> cancel(UUID actor, UUID task, long expectedRevision, String requestId) {
        return change(actor, task, expectedRevision, requestId, "cancel_planning_task", row -> {
            if (List.of("completed", "cancelled", "superseded", "failed").contains(row.status())) throw new TravelError("task_already_finished");
            jdbc.update("""
                    UPDATE travel_planning_tasks SET status='cancelled',generation=generation+1,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
                    WHERE task_id=?
                    """, task);
        });
    }

    private Map<String, Object> change(UUID actor, UUID task, long expectedRevision, String requestId, String type, java.util.function.Consumer<TaskRow> operation) {
        if (actor == null || task == null || expectedRevision < 0) throw new TravelError("invalid_task_input");
        UUID trip = taskTrip(task);
        var input = Map.of("taskId", task.toString(), "expectedRevision", expectedRevision);
        return receipt(actor, requestId, type, input, () -> accessLocked(actor, trip, true), () -> {
            var current = accessLocked(actor, trip, true);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            operation.accept(taskLocked(task));
            return taskView(task);
        });
    }

    /** Called only by a separately authenticated executor endpoint. */
    public Map<String, Object> claim() {
        if (!enabled) throw new TravelError("background_executor_not_configured");
        return transactions.execute(status -> {
            advisory("travel-planning-capacity");
            int running = jdbc.queryForObject("SELECT count(*) FROM travel_planning_tasks WHERE status='running' AND lease_until>CURRENT_TIMESTAMP", Integer.class);
            if (running >= maxRunning) return Map.of("status", "capacity_full");
            for (int attempts = 0; attempts < 50; attempts++) {
                var candidates = jdbc.query("""
                        SELECT q.task_id,q.trip_id FROM travel_planning_tasks q
                        WHERE (q.status='queued' OR (q.status='running' AND q.lease_until<=CURRENT_TIMESTAMP))
                          AND (SELECT count(*) FROM travel_planning_tasks a WHERE a.created_by=q.created_by
                               AND a.status='running' AND a.lease_until>CURRENT_TIMESTAMP) < ?
                        ORDER BY q.created_at,q.task_id LIMIT 1
                        """, (rs, n) -> new Candidate(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)), maxRunningPerAccount);
                if (candidates.isEmpty()) return Map.of("status", "empty");
                var candidate = candidates.get(0);
                var trips = jdbc.query("SELECT revision,state::text FROM travel_trips WHERE trip_id=? FOR UPDATE",
                        (rs, n) -> new LockedTrip(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), candidate.trip());
                if (trips.isEmpty()) continue;
                var task = taskLocked(candidate.task());
                if (!("queued".equals(task.status()) || ("running".equals(task.status()) && task.expired()))) continue;
                var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), candidate.trip(), task.owner());
                if (roles.isEmpty() || !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0)))) {
                    jdbc.update("UPDATE travel_planning_tasks SET status='cancelled',generation=generation+1,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE task_id=?", candidate.task());
                    continue;
                }
                if (trips.get(0).revision() != task.baseRevision()) {
                    jdbc.update("UPDATE travel_planning_tasks SET status='superseded',generation=generation+1,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE task_id=?", candidate.task());
                    continue;
                }
                UUID lease = UUID.randomUUID();
                jdbc.update("""
                        UPDATE travel_planning_tasks SET status='running',generation=generation+1,lease_id=?,
                        lease_until=CURRENT_TIMESTAMP + INTERVAL '60 seconds',updated_at=CURRENT_TIMESTAMP WHERE task_id=?
                        """, lease, candidate.task());
                var claimed = taskView(candidate.task());
                claimed.put("leaseId", lease.toString());
                claimed.put("tripState", trips.get(0).state());
                return claimed;
            }
            return Map.of("status", "empty");
        });
    }

    public Map<String, Object> checkpoint(UUID task, long generation, UUID lease, Map<String, Object> checkpoint) {
        var safe = TripStateFactory.safeObject(checkpoint);
        String content = json.writeValueAsString(safe);
        if (content.length() > 65536) throw new TravelError("checkpoint_too_large");
        return workerChange(task, generation, lease, row -> jdbc.update("""
                UPDATE travel_planning_tasks SET checkpoint=CAST(? AS jsonb),lease_until=CURRENT_TIMESTAMP + INTERVAL '60 seconds',updated_at=CURRENT_TIMESTAMP
                WHERE task_id=?
                """, content, task));
    }

    public Map<String, Object> heartbeat(UUID task, long generation, UUID lease) {
        return workerChange(task, generation, lease, row -> jdbc.update("""
                UPDATE travel_planning_tasks SET lease_until=CURRENT_TIMESTAMP + INTERVAL '60 seconds',updated_at=CURRENT_TIMESTAMP
                WHERE task_id=?
                """, task));
    }

    public Map<String, Object> fail(UUID task, long generation, UUID lease, String code) {
        if (code == null || !List.of("model_unavailable", "model_output_invalid", "worker_error").contains(code)) throw new TravelError("invalid_task_input");
        return workerChange(task, generation, lease, row -> jdbc.update("""
                UPDATE travel_planning_tasks SET status='failed',failure_code=?,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
                WHERE task_id=?
                """, code, task));
    }

    public WorkerContext workerContext(UUID task, long generation, UUID lease) {
        if (task == null || lease == null || generation < 1) throw new TravelError("invalid_task_input");
        UUID trip = taskTrip(task);
        return transactions.execute(status -> {
            var trips = jdbc.query("SELECT revision,state::text FROM travel_trips WHERE trip_id=? FOR UPDATE",
                    (rs, n) -> new LockedTrip(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
            if (trips.isEmpty()) throw new TravelError("task_not_found");
            var row = taskLocked(task);
            verifyWorker(row, generation, lease, trips.get(0));
            return new WorkerContext(row.owner(), trip, row.baseRevision(), trips.get(0).state());
        });
    }

    public Map<String, Object> finish(UUID task, long generation, UUID lease, Map<String, Object> output) {
        var safe = TripStateFactory.safeObject(output);
        if (!safe.keySet().stream().allMatch(List.of("kind", "summary", "evidenceIds", "unknowns", "stops")::contains)
                || !(safe.get("summary") instanceof String summary) || summary.isBlank() || summary.length() > 4000
                || !(safe.get("kind") instanceof String kind) || !List.of("suggestion", "needs_context", "itinerary_proposal").contains(kind)
                || !(safe.get("evidenceIds") instanceof List<?> evidence) || evidence.size() > 20
                || !(safe.get("unknowns") instanceof List<?> unknowns) || unknowns.size() > 20
                || unknowns.stream().anyMatch(item -> !(item instanceof String))) throw new TravelError("invalid_task_output");
        if (!"needs_context".equals(kind) && evidence.isEmpty()) throw new TravelError("source_evidence_required");
        boolean itinerary = "itinerary_proposal".equals(kind);
        if (itinerary != safe.containsKey("stops") || (itinerary && (!(safe.get("stops") instanceof List<?> stops) || stops.isEmpty() || stops.size() > 128 || stops.stream().anyMatch(stop -> !(stop instanceof Map<?, ?>)))))
            throw new TravelError("invalid_task_output");
        var evidenceIds = new ArrayList<UUID>();
        try { for (Object item : evidence) evidenceIds.add(UUID.fromString((String) item)); }
        catch (RuntimeException invalid) { throw new TravelError("invalid_task_output"); }
        String content = json.writeValueAsString(safe);
        if (content.length() > 65536) throw new TravelError("invalid_task_output");
        return workerChange(task, generation, lease, row -> {
            for (UUID result : evidenceIds) {
                var ok = jdbc.queryForObject("""
                        SELECT EXISTS(SELECT 1 FROM travel_result_references WHERE result_id=? AND trip_id=? AND trip_revision=?
                                      AND fresh_until>CURRENT_TIMESTAMP AND data IS NOT NULL)
                        """, Boolean.class, result, row.trip(), row.baseRevision());
                if (!Boolean.TRUE.equals(ok)) throw new TravelError("source_evidence_unavailable");
            }
            var savedOutput = new LinkedHashMap<>(safe);
            if (itinerary) {
                @SuppressWarnings("unchecked") var stops = (List<Map<String, Object>>) safe.get("stops");
                if (stops.stream().anyMatch(stop -> stop == null || !evidence.contains(stop.get("sourceResultId")))) throw new TravelError("invalid_task_output");
                var draft = drafts.stage(row.owner(), row.trip(), row.baseRevision(), "worker-draft:" + task + ":" + generation, stops);
                savedOutput.put("draftId", draft.get("draftId")); savedOutput.put("draftRevision", draft.get("draftRevision"));
            }
            jdbc.update("""
                    UPDATE travel_planning_tasks SET status=?,suggestion=CAST(? AS jsonb),lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
                    WHERE task_id=?
                    """, "needs_context".equals(kind) ? "needs_context" : "completed", json.writeValueAsString(savedOutput), task);
        });
    }

    private Map<String, Object> workerChange(UUID task, long generation, UUID lease, java.util.function.Consumer<TaskRow> operation) {
        if (task == null || lease == null || generation < 1) throw new TravelError("invalid_task_input");
        UUID trip = taskTrip(task);
        return transactions.execute(status -> {
            var trips = jdbc.query("SELECT revision,state::text FROM travel_trips WHERE trip_id=? FOR UPDATE",
                    (rs, n) -> new LockedTrip(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
            if (trips.isEmpty()) throw new TravelError("task_not_found");
            var row = taskLocked(task);
            verifyWorker(row, generation, lease, trips.get(0));
            operation.accept(row);
            return taskView(task);
        });
    }

    private void verifyWorker(TaskRow row, long generation, UUID lease, LockedTrip trip) {
        if (!"running".equals(row.status()) || row.expired() || row.generation() != generation || !lease.equals(row.lease())) throw new TravelError("stale_execution");
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), row.trip(), row.owner());
        if (roles.isEmpty() || !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0)))) throw new TravelError("permission_revoked");
        if (trip.revision() != row.baseRevision()) throw new TravelError("revision_conflict");
    }

    private LockedTrip accessLocked(UUID actor, UUID trip, boolean write) {
        var rows = jdbc.query("SELECT revision,state::text FROM travel_trips WHERE trip_id=? FOR UPDATE",
                (rs, n) -> new LockedTrip(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
        if (rows.isEmpty()) throw new TravelError("task_not_found");
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, actor);
        if (roles.isEmpty() || (write && !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0))))) throw new TravelError("task_not_found");
        return rows.get(0);
    }
    private UUID taskTrip(UUID task) {
        var rows = jdbc.query("SELECT trip_id FROM travel_planning_tasks WHERE task_id=?", (rs, n) -> rs.getObject(1, UUID.class), task);
        if (rows.isEmpty()) throw new TravelError("task_not_found");
        return rows.get(0);
    }
    private TaskRow taskLocked(UUID task) {
        var rows = jdbc.query("""
                SELECT trip_id,created_by,base_revision,generation,status,lease_id,(lease_until IS NULL OR lease_until<=CURRENT_TIMESTAMP)
                FROM travel_planning_tasks WHERE task_id=? FOR UPDATE
                """, (rs, n) -> new TaskRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getLong(3), rs.getLong(4),
                rs.getString(5), rs.getObject(6, UUID.class), rs.getBoolean(7)), task);
        if (rows.isEmpty()) throw new TravelError("task_not_found");
        return rows.get(0);
    }
    private Map<String, Object> taskView(UUID task) {
        var rows = jdbc.query("""
                SELECT task_id,trip_id,objective,base_revision,generation,status,checkpoint::text,suggestion::text,
                       created_at,updated_at,(status='running' AND lease_until<=CURRENT_TIMESTAMP),failure_code,
                       (base_revision<>(SELECT revision FROM travel_trips WHERE trip_id=travel_planning_tasks.trip_id))
                FROM travel_planning_tasks WHERE task_id=?
                """, (rs, n) -> taskView(rs), task);
        if (rows.isEmpty()) throw new TravelError("task_not_found");
        return rows.get(0);
    }
    private Map<String, Object> taskView(java.sql.ResultSet rs) throws java.sql.SQLException {
        var out = new LinkedHashMap<String, Object>();
        out.put("taskId", rs.getObject(1, UUID.class).toString()); out.put("tripId", rs.getObject(2, UUID.class).toString());
        out.put("objective", rs.getString(3)); out.put("baseRevision", rs.getLong(4)); out.put("generation", rs.getLong(5));
        out.put("status", rs.getBoolean(11) ? "recovering" : rs.getString(6));
        out.put("checkpoint", rs.getString(7) == null ? null : json.readValue(rs.getString(7), OBJECT));
        out.put("suggestion", rs.getString(8) == null ? null : json.readValue(rs.getString(8), OBJECT));
        out.put("createdAt", rs.getTimestamp(9).toInstant().toString()); out.put("updatedAt", rs.getTimestamp(10).toInstant().toString());
        out.put("failureCode", rs.getString(12));
        out.put("stale", rs.getBoolean(13));
        return out;
    }

    private Map<String, Object> receipt(UUID actor, String requestId, String type, Object input, Runnable authorize, Supplier<Map<String, Object>> operation) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String digest = hash(json.writeValueAsString(canonical(input)));
        return transactions.execute(status -> {
            advisory(actor + ":" + requestId);
            authorize.run();
            var previous = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!previous.isEmpty()) {
                var found = previous.get(0);
                if (!type.equals(found.type()) || !digest.equals(found.digest())) throw new TravelError("request_id_conflict");
                var recorded = json.readValue(found.response(), OBJECT);
                return taskView(UUID.fromString((String) recorded.get("taskId")));
            }
            var result = operation.get();
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,CAST(? AS jsonb))",
                    actor, requestId, type, digest, json.writeValueAsString(result));
            return result;
        });
    }
    private void advisory(String key) { jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, key); }
    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) { var out = new TreeMap<String, Object>(); map.forEach((k, v) -> out.put((String) k, canonical(v))); return out; }
        if (value instanceof List<?> list) return list.stream().map(TravelTasks::canonical).toList();
        return value;
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private record LockedTrip(long revision, Map<String, Object> state) {}
    private record Candidate(UUID task, UUID trip) {}
    private record TaskRow(UUID trip, UUID owner, long baseRevision, long generation, String status, UUID lease, boolean expired) {}
    private record Receipt(String type, String digest, String response) {}
    public record WorkerContext(UUID accountId, UUID tripId, long revision, Map<String, Object> state) {}
}
