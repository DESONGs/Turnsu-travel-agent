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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** A UI request and its delivery report are durable; neither implies that an assistant completed work. */
@Service
public class WorkbenchRequests {
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JsonMapper json = JsonMapper.builder().build();

    public WorkbenchRequests(JdbcTemplate jdbc, TransactionTemplate transactions) { this.jdbc = jdbc; this.transactions = transactions; }

    public Map<String, Object> create(UUID actor, UUID trip, UUID draft, long expectedRevision, long expectedDraftRevision, String requestId) {
        if (actor == null || trip == null || draft == null || expectedRevision < 0 || expectedDraftRevision < 0) throw new TravelError("invalid_workbench_request");
        return receipt(actor, trip, requestId, "create_workbench_request", Map.of("tripId", trip.toString(), "draftId", draft.toString(), "expectedRevision", expectedRevision, "expectedDraftRevision", expectedDraftRevision), false, () -> {
            if (lockTrip(actor, trip, true) != expectedRevision) throw new TravelError("revision_conflict");
            var revisions = jdbc.query("SELECT draft_revision FROM travel_itinerary_drafts WHERE trip_id=? AND draft_id=? AND status='proposed'", (rs, n) -> rs.getLong(1), trip, draft);
            if (revisions.isEmpty()) throw new TravelError("draft_not_found");
            if (revisions.get(0) != expectedDraftRevision) throw new TravelError("draft_revision_conflict");
            UUID id = UUID.randomUUID();
            jdbc.update("INSERT INTO travel_workbench_requests(handoff_id,trip_id,draft_id,requested_by,trip_revision,draft_revision,notification,work_status) VALUES (?,?,?,?,?,?,'saved','saved')",
                    id, trip, draft, actor, expectedRevision, expectedDraftRevision);
            return read(actor, id);
        });
    }

    /** A replay never grants another send attempt, even if the first response was lost. */
    public Map<String, Object> beginNotification(UUID actor, UUID trip, UUID id, long expectedRevision, String requestId) {
        if (actor == null || trip == null || id == null || expectedRevision < 0) throw new TravelError("invalid_workbench_request");
        return receipt(actor, trip, requestId, "begin_workbench_notification", Map.of("tripId", trip.toString(), "handoffId", id.toString(), "expectedRevision", expectedRevision), true, () -> {
            if (lockTrip(actor, trip, true) != expectedRevision) throw new TravelError("revision_conflict");
            var current = lockRequest(actor, trip, id, true);
            if ("superseded".equals(current.get("workStatus"))) throw new TravelError("request_superseded");
            if (!"saved".equals(current.get("notification"))) throw new TravelError("notification_already_started");
            jdbc.update("UPDATE travel_workbench_requests SET notification='sending',updated_at=CURRENT_TIMESTAMP WHERE handoff_id=?", id);
            var response = new LinkedHashMap<>(read(actor, id)); response.put("maySend", true); return response;
        });
    }

    public Map<String, Object> recordNotification(UUID actor, UUID trip, UUID id, long expectedRevision, String requestId, String outcome) {
        if (actor == null || trip == null || id == null || expectedRevision < 0 || outcome == null || !List.of("sent", "failed", "unknown").contains(outcome)) throw new TravelError("invalid_workbench_request");
        return receipt(actor, trip, requestId, "record_workbench_notification", Map.of("tripId", trip.toString(), "handoffId", id.toString(), "expectedRevision", expectedRevision, "outcome", outcome), false, () -> {
            if (lockTrip(actor, trip, true) != expectedRevision) throw new TravelError("revision_conflict");
            var current = lockRequest(actor, trip, id, true);
            if (!"sending".equals(current.get("notification"))) throw new TravelError("notification_already_recorded");
            jdbc.update("UPDATE travel_workbench_requests SET notification=?,updated_at=CURRENT_TIMESTAMP WHERE handoff_id=?", outcome, id);
            return read(actor, id);
        });
    }

    public Map<String, Object> acknowledge(UUID actor, UUID trip, UUID id, long expectedRevision, String requestId) {
        if (actor == null || trip == null || id == null || expectedRevision < 0) throw new TravelError("invalid_workbench_request");
        return receipt(actor, trip, requestId, "acknowledge_workbench_request", Map.of("tripId", trip.toString(), "handoffId", id.toString(), "expectedRevision", expectedRevision), false, () -> {
            if (lockTrip(actor, trip, true) != expectedRevision) throw new TravelError("revision_conflict");
            var current = lockRequest(actor, trip, id, false);
            if ("superseded".equals(current.get("workStatus"))) throw new TravelError("request_superseded");
            jdbc.update("UPDATE travel_workbench_requests SET work_status='accepted',updated_at=CURRENT_TIMESTAMP WHERE handoff_id=?", id);
            return read(actor, id);
        });
    }

    public Map<String, Object> read(UUID actor, UUID id) {
        if (actor == null || id == null) throw new TravelError("request_not_found");
        var rows = jdbc.query("""
                SELECT r.handoff_id,r.trip_id,r.draft_id,r.trip_revision,r.draft_revision,r.notification,r.work_status,r.created_at,r.requested_by,t.revision
                FROM travel_workbench_requests r JOIN travel_trip_access a ON a.trip_id=r.trip_id JOIN travel_trips t ON t.trip_id=r.trip_id
                WHERE r.handoff_id=? AND a.account_id=?
                """, (rs, n) -> view(rs), id, actor);
        if (rows.isEmpty()) throw new TravelError("request_not_found");
        return rows.get(0);
    }

    public Map<String, Object> list(UUID actor, UUID trip, int limit, Instant beforeTime, UUID beforeId) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        if (limit < 1 || limit > 50 || (beforeTime == null) != (beforeId == null)) throw new TravelError("invalid_page");
        return transactions.execute(status -> {
            lockTrip(actor, trip, false);
            String sql = """
                    SELECT r.handoff_id,r.trip_id,r.draft_id,r.trip_revision,r.draft_revision,r.notification,r.work_status,r.created_at,r.requested_by,t.revision
                    FROM travel_workbench_requests r JOIN travel_trips t ON t.trip_id=r.trip_id WHERE r.trip_id=?
                    """ + (beforeTime == null ? "" : " AND (r.created_at,r.handoff_id) < (?,?) ") + " ORDER BY r.created_at DESC,r.handoff_id DESC LIMIT ?";
            var mapper = (org.springframework.jdbc.core.RowMapper<Map<String, Object>>) (rs, n) -> view(rs);
            var rows = beforeTime == null ? jdbc.query(sql, mapper, trip, limit + 1)
                    : jdbc.query(sql, mapper, trip, java.sql.Timestamp.from(beforeTime), beforeId, limit + 1);
            var items = rows.size() > limit ? rows.subList(0, limit) : rows;
            Object cursor = rows.size() > limit ? Map.of("createdAt", items.get(items.size() - 1).get("createdAt"), "handoffId", items.get(items.size() - 1).get("handoffId")) : null;
            var result = new LinkedHashMap<String, Object>(); result.put("items", items); result.put("nextCursor", cursor); return result;
        });
    }

    private Map<String, Object> lockRequest(UUID actor, UUID trip, UUID id, boolean ownerOnly) {
        if (id == null) throw new TravelError("request_not_found");
        var rows = jdbc.query("SELECT requested_by,notification,work_status FROM travel_workbench_requests WHERE handoff_id=? AND trip_id=? FOR UPDATE",
                (rs, n) -> Map.<String, Object>of("requestedBy", rs.getObject(1, UUID.class), "notification", rs.getString(2), "workStatus", rs.getString(3)), id, trip);
        if (rows.isEmpty() || (ownerOnly && !actor.equals(rows.get(0).get("requestedBy")))) throw new TravelError("request_not_found");
        return rows.get(0);
    }
    private long lockTrip(UUID actor, UUID trip, boolean write) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        var revisions = jdbc.query("SELECT revision FROM travel_trips WHERE trip_id=?" + (write ? " FOR UPDATE" : ""), (rs, n) -> rs.getLong(1), trip);
        if (revisions.isEmpty()) throw new TravelError("trip_not_found");
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, actor);
        if (roles.isEmpty() || (write && !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0))))) throw new TravelError("trip_not_found");
        return revisions.get(0);
    }
    private static Map<String, Object> view(java.sql.ResultSet rs) throws java.sql.SQLException {
        return Map.of("handoffId", rs.getObject(1, UUID.class).toString(), "tripId", rs.getObject(2, UUID.class).toString(),
                "draftId", rs.getObject(3, UUID.class).toString(), "tripRevision", rs.getLong(4), "draftRevision", rs.getLong(5), "notification", rs.getString(6),
                "workStatus", rs.getString(7), "createdAt", rs.getTimestamp(8).toInstant().toString(), "requestedBy", rs.getObject(9, UUID.class).toString(),
                "stale", rs.getLong(4) != rs.getLong(10));
    }

    private Map<String, Object> receipt(UUID actor, UUID trip, String requestId, String kind, Object input, boolean noResendOnReplay, Supplier<Map<String, Object>> action) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String digest = hash(json.writeValueAsString(canonical(input)));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, actor + ":" + requestId);
            lockTrip(actor, trip, true);
            var rows = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> Map.of("kind", rs.getString(1), "hash", rs.getString(2), "response", rs.getString(3)), actor, requestId);
            if (!rows.isEmpty()) {
                var previous = rows.get(0);
                if (!kind.equals(previous.get("kind")) || !digest.equals(previous.get("hash"))) throw new TravelError("request_id_conflict");
                var recorded = json.readValue(previous.get("response"), OBJECT);
                UUID id = UUID.fromString((String) recorded.get("handoffId"));
                var response = new LinkedHashMap<>(read(actor, id));
                if ("acknowledge_workbench_request".equals(kind) && "superseded".equals(response.get("workStatus"))) throw new TravelError("request_superseded");
                if (noResendOnReplay) response.put("maySend", false);
                return response;
            }
            var response = action.get();
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,CAST(? AS jsonb))",
                    actor, requestId, kind, digest, json.writeValueAsString(response));
            return response;
        });
    }
    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) { var sorted = new TreeMap<String, Object>(); map.forEach((k, v) -> sorted.put((String) k, canonical(v))); return sorted; }
        if (value instanceof List<?> list) { var copy = new ArrayList<>(); list.forEach(item -> copy.add(canonical(item))); return copy; }
        return value;
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
